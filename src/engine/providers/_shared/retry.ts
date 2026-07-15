import { ProviderHttpError, QuotaExhaustedError } from "@/kernel/std/types/error-meta.ts";

export { ProviderHttpError, QuotaExhaustedError };

export const BASE_DELAY_MS = 500;
export const DEFAULT_MAX_DELAY_MS = 32_000;
export const DEFAULT_MAX_RETRIES = 10;
export const RETRY_AFTER_TOO_LONG_MS = 60_000;

export function getRetryDelay(
  attempt: number,
  retryAfterMs: number | null = null,
  maxDelayMs: number = DEFAULT_MAX_DELAY_MS,
): number {
  if (retryAfterMs !== null && retryAfterMs > 0) return retryAfterMs;
  const safeAttempt = Math.max(1, attempt);
  const baseDelay = Math.min(BASE_DELAY_MS * 2 ** (safeAttempt - 1), maxDelayMs);
  const jitter = Math.random() * 0.25 * baseDelay;
  return baseDelay + jitter;
}

export function parseRetryAfterHeader(headerValue: string | null | undefined): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return null;
  const seconds = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

export type HttpDecision =
  | { kind: "retry"; delayMs: number; reason: string }
  | { kind: "fail"; reason: string };

export interface ClassifyHttpInput {
  status: number;
  attempt: number;
  retryAfterMs?: number | null;
  reason?: string;
  shouldRetryHeader?: string | null;
}

export function classifyHttpStatus(input: ClassifyHttpInput): HttpDecision {
  const { status, attempt, shouldRetryHeader } = input;
  const reason = input.reason ?? `HTTP ${status}`;
  const retryAfterMs = input.retryAfterMs ?? null;

  if (shouldRetryHeader === "false") return { kind: "fail", reason };
  const headerSaysRetry = shouldRetryHeader === "true";

  if (
    headerSaysRetry ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status === 529 ||
    (status >= 500 && status < 600)
  ) {
    if (retryAfterMs !== null && retryAfterMs > RETRY_AFTER_TOO_LONG_MS) {
      return { kind: "fail", reason };
    }
    return { kind: "retry", delayMs: getRetryDelay(attempt, retryAfterMs), reason };
  }

  return { kind: "fail", reason };
}

const TRANSIENT_NODE_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  // Bun runtime network errors carry Bun-specific codes, not node errnos —
  // fetch() connection failures surface as ConnectionRefused even for DNS.
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
]);

const TERMINAL_NETWORK_CODES = new Set([
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
]);

const TRANSIENT_NETWORK_MESSAGE_PATTERNS: RegExp[] = [
  /ECONNRESET/i,
  /EPIPE/i,
  /ETIMEDOUT/i,
  /UND_ERR_SOCKET/i,
  /fetch failed/i,
  /network/i,
  /connection refused/i,
  /socket connection was closed unexpectedly/i,
  /websocket.*closed/i,
  /ws closed before completion/i,
  /operation timed out/i,
  // Bun runtime network failure messages (fetch / WebSocket / socket open).
  /unable to connect/i,
  /was there a typo in the url or port/i,
  /failed to connect/i,
];

const TERMINAL_NETWORK_MESSAGE_PATTERNS: RegExp[] = [
  /Hostname\/IP does not match certificate/i,
  /Cert does not contain/i,
  /altnames/i,
  /certificate has expired/i,
  /self[-\s]?signed certificate/i,
  /unable to verify/i,
];

export function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (isTerminalNetworkError(err)) return false;
  if (currentErrorIsTransient(err)) return true;
  const cause = (err as { cause?: unknown }).cause;
  return cause && typeof cause === "object" ? isTransientNetworkError(cause) : false;
}

function currentErrorIsTransient(err: object): boolean {
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NODE_CODES.has(code)) return true;
  // AbortSignal.timeout() rejects with a DOMException named "TimeoutError"
  // (message "The operation timed out."). It carries no string `.code` and the
  // message would otherwise miss the patterns, surfacing the foreground error
  // dialog instead of a bounded retry. A user-initiated cancel is "AbortError",
  // not "TimeoutError", so this never retries cancellations.
  if ((err as { name?: unknown }).name === "TimeoutError") return true;
  const message = errorMessage(err);
  return (
    message !== null && TRANSIENT_NETWORK_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
  );
}

function isTerminalNetworkError(err: object): boolean {
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TERMINAL_NETWORK_CODES.has(code)) return true;
  const message = errorMessage(err);
  if (
    message !== null &&
    TERMINAL_NETWORK_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
  ) {
    return true;
  }
  const cause = (err as { cause?: unknown }).cause;
  return cause && typeof cause === "object" ? isTerminalNetworkError(cause) : false;
}

function errorMessage(err: object): string | null {
  if (err instanceof Error && err.message.length > 0) return err.message;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && message.length > 0 ? message : null;
}

const ANTHROPIC_ERROR_TYPE_TO_STATUS: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 529,
};

const OPENAI_ERROR_CODE_TO_STATUS: Record<string, number> = {
  context_length_exceeded: 400,
  invalid_prompt: 400,
  bio_policy: 400,
  cyber_policy: 400,
  insufficient_quota: 429,
  usage_limit_reached: 429,
  usage_not_included: 429,
  rate_limit_exceeded: 429,
  server_is_overloaded: 529,
  slow_down: 529,
};

export function streamErrorToHttpError(opts: {
  provider: string;
  rawBody: string;
  fallbackStatus?: number;
}): ProviderHttpError {
  const fallbackStatus = opts.fallbackStatus ?? 500;
  let status = fallbackStatus;
  let body = opts.rawBody;
  try {
    const parsed = JSON.parse(opts.rawBody) as Record<string, unknown>;
    const errObj = (parsed.error ?? parsed) as Record<string, unknown> | undefined;
    const type = errObj && typeof errObj.type === "string" ? errObj.type : null;
    if (type && ANTHROPIC_ERROR_TYPE_TO_STATUS[type] !== undefined) {
      status = ANTHROPIC_ERROR_TYPE_TO_STATUS[type] ?? fallbackStatus;
    } else {
      const code = errObj && typeof errObj.code === "string" ? errObj.code : null;
      if (code && OPENAI_ERROR_CODE_TO_STATUS[code] !== undefined) {
        status = OPENAI_ERROR_CODE_TO_STATUS[code] ?? fallbackStatus;
      }
    }
    body = JSON.stringify({ error: errObj });
  } catch {}
  const quota = detectQuotaExhaustion({ status, body });
  return new ProviderHttpError({
    provider: opts.provider,
    status,
    body,
    quotaExhausted: quota.quotaExhausted,
    quotaResetEpochMs: quota.resetEpochMs,
  });
}

const QUOTA_PATTERNS: RegExp[] = [
  /insufficient[_\s-]?quota/i,
  /quota[_\s-]?exceeded/i,
  /quota[_\s-]?exhaust/i,
  /usage[_\s-]?limit/i,
  /billing[_\s-]?hard[_\s-]?limit/i,
  /you exceeded your current quota/i,
  /maximum.*quota/i,
];

const CODEX_USAGE_LIMIT_TYPE = "usage_limit_reached";
const MS_PER_SECOND = 1000;

function codexResetEpochMs(resetsAtSec: number | null, resetsInSec: number | null): number | null {
  if (resetsAtSec !== null) return resetsAtSec * MS_PER_SECOND;
  if (resetsInSec !== null) return Date.now() + resetsInSec * MS_PER_SECOND;
  return null;
}

function detectCodexUsageLimit(body: string): {
  quotaExhausted: boolean;
  resetEpochMs: number | null;
} {
  if (body.length === 0) return { quotaExhausted: false, resetEpochMs: null };
  try {
    const parsed = JSON.parse(body.length > 4000 ? body.slice(0, 4000) : body);
    const errObj = parsed?.error ?? parsed;
    const errType = errObj && typeof errObj.type === "string" ? errObj.type : null;
    if (errType !== CODEX_USAGE_LIMIT_TYPE) return { quotaExhausted: false, resetEpochMs: null };
    const meta = errObj && typeof errObj.metadata === "object" ? errObj.metadata : null;
    const directReset = errObj && typeof errObj.resets_at === "number" ? errObj.resets_at : null;
    const metaReset = meta && typeof meta.resets_at === "number" ? meta.resets_at : null;
    const resetsInSec =
      errObj && typeof errObj.resets_in_seconds === "number" ? errObj.resets_in_seconds : null;
    return {
      quotaExhausted: true,
      resetEpochMs: codexResetEpochMs(directReset ?? metaReset, resetsInSec),
    };
  } catch {
    return { quotaExhausted: false, resetEpochMs: null };
  }
}

export interface QuotaDetectInput {
  status: number;
  headers?: Headers | Record<string, string | null | undefined>;
  body?: string;
  retryAfterMs?: number | null;
}

function readHeader(headers: QuotaDetectInput["headers"], name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const rec = headers as Record<string, string | null | undefined>;
  return rec[name] ?? rec[name.toLowerCase()] ?? null;
}

export function detectQuotaExhaustion(input: QuotaDetectInput): {
  quotaExhausted: boolean;
  resetEpochMs: number | null;
} {
  const { status, body = "", headers, retryAfterMs } = input;
  const unifiedStatus = readHeader(headers, "anthropic-ratelimit-unified-status");
  if (unifiedStatus === "rejected") {
    return detectUnifiedRejectedQuota({ retryAfterMs, headers });
  }
  const codexUsageLimit = detectCodexUsageLimit(body);
  if (codexUsageLimit.quotaExhausted) return codexUsageLimit;
  if (status === 429 || status === 403) {
    const haystack = body.length > 4000 ? body.slice(0, 4000) : body;
    if (QUOTA_PATTERNS.some((re) => re.test(haystack))) {
      const resetEpochMs =
        retryAfterMs !== null && retryAfterMs !== undefined ? Date.now() + retryAfterMs : null;
      return { quotaExhausted: true, resetEpochMs };
    }
  }
  if (
    (status === 429 || status === 529) &&
    retryAfterMs !== null &&
    retryAfterMs !== undefined &&
    retryAfterMs > RETRY_AFTER_TOO_LONG_MS
  ) {
    return { quotaExhausted: true, resetEpochMs: Date.now() + retryAfterMs };
  }
  return { quotaExhausted: false, resetEpochMs: null };
}

// Shared by Anthropic + Anthropic-compat gateways (Z.AI/GLM, Kimi, MiniMax,
// DeepSeek when they stamp the same headers). Soft concurrent rate limits often
// look identical to plan rejection at the header level (unified-status=rejected).
// Require BOTH an explicit near-term retry invite AND a known short wait before
// treating as soft — missing wait stays hard so Anthropic Max/Pro multi-hour
// plan blocks (should-retry:true but hours away) never degrade into silent retry.
function detectUnifiedRejectedQuota(input: {
  retryAfterMs: number | null | undefined;
  headers: QuotaDetectInput["headers"];
}): { quotaExhausted: boolean; resetEpochMs: number | null } {
  const shouldRetry = readHeader(input.headers, "x-should-retry");
  const resetSec = readHeader(input.headers, "anthropic-ratelimit-unified-reset");
  const resetFromHeader =
    resetSec && Number.isFinite(Number(resetSec)) ? Number(resetSec) * 1000 : null;
  const waitMs = effectiveRetryWaitMs(input.retryAfterMs, resetFromHeader);
  if (shouldRetry === "true" && waitMs !== null && waitMs <= RETRY_AFTER_TOO_LONG_MS) {
    return { quotaExhausted: false, resetEpochMs: null };
  }
  const resetEpochMs =
    resetFromHeader ??
    (input.retryAfterMs !== null && input.retryAfterMs !== undefined
      ? Date.now() + input.retryAfterMs
      : null);
  return { quotaExhausted: true, resetEpochMs };
}

function effectiveRetryWaitMs(
  retryAfterMs: number | null | undefined,
  resetEpochMs: number | null,
): number | null {
  if (retryAfterMs !== null && retryAfterMs !== undefined) return retryAfterMs;
  if (resetEpochMs !== null && Number.isFinite(resetEpochMs)) {
    return Math.max(0, resetEpochMs - Date.now());
  }
  return null;
}

export function extractBodyMessage(body: string): string | null {
  if (!body || body.length === 0) return null;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const errObj = parsed?.error;
    if (errObj && typeof errObj === "object") {
      const msg = (errObj as Record<string, unknown>).message;
      if (typeof msg === "string" && msg.length > 0) return msg;
    }
    if (typeof parsed?.message === "string") return parsed.message;
  } catch {}
  return null;
}

export function extractHttpStatus(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number" && status > 0) return status;
  if (err instanceof Error) {
    const m = err.message.match(/\bHTTP (\d{3})\b/);
    if (m?.[1]) return Number.parseInt(m[1], 10);
  }
  return null;
}
