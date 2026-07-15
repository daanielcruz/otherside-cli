import type { RetryDecision } from "@/engine/contract/types.ts";
import { detectQuotaExhaustion, ProviderHttpError } from "@/engine/providers/_shared/retry.ts";
import { classifyProviderError } from "@/engine/transport/_infra/classify/classify.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const MAX_RETRY_DELAY_MS = 60 * 1000;
const MAX_RETRYABLE_DELAY_MS = 300_000;

const CLOUDCODE_DOMAINS = new Set([
  "cloudcode-pa.googleapis.com",
  "staging-cloudcode-pa.googleapis.com",
  "autopush-cloudcode-pa.googleapis.com",
]);

interface ParsedQuotaError {
  status: string;
  reason: string;
  message: string;
  retryDelayMs: number | null;
  quotaId: string;
  domain: string;
}

function parseGoogleErrorBody(body: string): ParsedQuotaError | null {
  if (!body) return null;
  try {
    const trimmed = body.trim().startsWith("[") ? JSON.parse(body)[0] : JSON.parse(body);
    const err = trimmed?.error;
    if (!err || typeof err !== "object") return null;
    const status = typeof err.status === "string" ? err.status : "";
    const message = typeof err.message === "string" ? err.message : "";
    let reason = "";
    let retryDelayMs: number | null = null;
    let quotaId = "";
    let domain = "";
    const details = Array.isArray(err.details) ? err.details : [];
    for (const d of details) {
      if (!d || typeof d !== "object") continue;
      const t = typeof d["@type"] === "string" ? d["@type"] : "";
      if (typeof d.reason === "string" && !reason) reason = d.reason;
      if (typeof d.domain === "string" && !domain) domain = d.domain;
      if (t.endsWith("google.rpc.QuotaFailure") && Array.isArray(d.violations)) {
        for (const v of d.violations) {
          if (v && typeof v.quotaId === "string" && !quotaId) {
            quotaId = v.quotaId;
            break;
          }
        }
      }
      if (typeof d.retryDelay === "string") {
        const m = d.retryDelay.match(/^(\d+(?:\.\d+)?)s$/);
        if (m) retryDelayMs = Math.round(Number.parseFloat(m[1]) * 1000);
      }
    }
    return { status, reason, message, retryDelayMs, quotaId, domain };
  } catch {
    return null;
  }
}

function isTransientThrottle(parsed: ParsedQuotaError): boolean {
  const isPerMinute = parsed.quotaId.includes("PerMinute") || parsed.quotaId.includes("PerSecond");
  const shortRetry = parsed.retryDelayMs !== null && parsed.retryDelayMs <= MAX_RETRYABLE_DELAY_MS;
  return isPerMinute || shortRetry;
}

function isTerminalQuota(parsed: ParsedQuotaError | null): boolean {
  if (!parsed) return false;
  if (parsed.reason === "GENERATIVE_MODEL_NOT_FOUND") return true;
  if (parsed.reason === "MODEL_NOT_FOUND") return true;
  if (parsed.reason === "INSUFFICIENT_G1_CREDITS_BALANCE") return true;
  if (parsed.quotaId.includes("PerDay") || parsed.quotaId.includes("Daily")) return true;
  if (CLOUDCODE_DOMAINS.has(parsed.domain) && parsed.reason === "QUOTA_EXHAUSTED") {
    return !isTransientThrottle(parsed);
  }
  if (parsed.retryDelayMs !== null && parsed.retryDelayMs > MAX_RETRYABLE_DELAY_MS) return true;
  return false;
}

function friendlyRetryReason(parsed: ParsedQuotaError | null, model: string): string {
  if (parsed?.reason === "MODEL_CAPACITY_EXHAUSTED") {
    return `${model} server busy, retrying`;
  }
  if (parsed?.reason === "RATE_LIMIT_EXCEEDED" || parsed?.status === "RESOURCE_EXHAUSTED") {
    return `${model} rate limited, retrying`;
  }
  return parsed?.message ?? `${model} 429, retrying`;
}

function terminalQuotaDetail(parsed: ParsedQuotaError | null, body: string, model: string): string {
  const message = parsed?.message.trim() ?? "";
  const reason = parsed?.reason.trim() ?? "";
  if (message && reason && message !== reason) return `${message} (${reason})`;
  if (message) return message;
  if (reason) return reason;
  const snippet = body.slice(0, 300).trim();
  if (snippet) return snippet;
  return `429 on ${model}`;
}

interface RateLimitErrorShape {
  body: string;
  status?: number;
  retryAfter?: number | null;
  retryAfterHeader?: string | null;
}

function readRetryAfterSeconds(rl: RateLimitErrorShape): number | null {
  if (typeof rl.retryAfter === "number") return rl.retryAfter;
  if (rl.retryAfter === null) return null;
  if (typeof rl.retryAfterHeader === "string") {
    const n = Number.parseInt(rl.retryAfterHeader, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

interface HttpErrorShape {
  status: number;
  body: string;
}

export interface GoogleFallbackSpec {
  providerId: ProviderId;
  rateLimitErrorCtor: new (...args: never[]) => RateLimitErrorShape;
  httpErrorCtor: new (...args: never[]) => HttpErrorShape;
}

export function makeGoogleRecoverableError(
  spec: GoogleFallbackSpec,
): (err: unknown, ctx: RequestContext, attempt?: number) => RetryDecision {
  return (err, ctx, attempt) => {
    const opts = { attempt: attempt ?? 1 };
    const rateLimitMatch =
      err instanceof spec.rateLimitErrorCtor &&
      ((err as RateLimitErrorShape).status === undefined ||
        (err as RateLimitErrorShape).status === 429);
    if (rateLimitMatch) {
      const rl = err as RateLimitErrorShape;
      const parsed = parseGoogleErrorBody(rl.body);
      if (isTerminalQuota(parsed)) {
        const detail = terminalQuotaDetail(parsed, rl.body, ctx.model);
        return {
          kind: "fail",
          reason: "quota_exhausted",
          userMessage: `${ctx.model}: ${detail}`,
          quotaExhausted: true,
          quotaResetEpochMs: null,
        };
      }
      const retryAfterSec = readRetryAfterSeconds(rl);
      const retryAfterMs = retryAfterSec !== null ? retryAfterSec * 1000 : null;
      const quota = detectQuotaExhaustion({ status: 429, body: rl.body, retryAfterMs });
      const transient = parsed ? isTransientThrottle(parsed) : false;
      const quotaExhausted = transient ? false : quota.quotaExhausted;
      const wrapped = new ProviderHttpError({
        provider: spec.providerId,
        status: 429,
        body: rl.body,
        retryAfterHeader: retryAfterSec !== null ? String(retryAfterSec) : null,
        quotaExhausted,
        quotaResetEpochMs: quotaExhausted ? quota.resetEpochMs : null,
      });
      const decision = classifyProviderError(wrapped, opts);
      if (decision.kind === "retry") {
        const serverHint = parsed?.retryDelayMs;
        if (serverHint && serverHint > decision.delayMs) decision.delayMs = serverHint;
        const attemptCap = Math.min(MAX_RETRY_DELAY_MS, 2000 * 2 ** (opts.attempt - 1));
        if (decision.delayMs > attemptCap) decision.delayMs = attemptCap;
        decision.reason = friendlyRetryReason(parsed, ctx.model);
      }
      return decision;
    }

    if (err instanceof spec.httpErrorCtor) {
      const he = err as HttpErrorShape;
      const quota = detectQuotaExhaustion({ status: he.status, body: he.body });
      const wrapped = new ProviderHttpError({
        provider: spec.providerId,
        status: he.status,
        body: he.body,
        quotaExhausted: quota.quotaExhausted,
        quotaResetEpochMs: quota.resetEpochMs,
      });
      return classifyProviderError(wrapped, opts);
    }

    return classifyProviderError(err, opts);
  };
}
