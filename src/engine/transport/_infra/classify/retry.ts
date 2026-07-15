import { extractBodyMessage } from "@/engine/providers/_shared/retry.ts";
import { markProviderCooldown } from "@/engine/session/usage/provider-health.ts";
import { classifyProviderError } from "@/engine/transport/_infra/classify/classify.ts";
import { classifyError } from "@/engine/transport/_infra/classify/error-classifier.ts";
import { StreamIdleTimeoutError } from "@/kernel/std/stream/idle-timeout.ts";
import { ProviderHttpError } from "@/kernel/std/types/error-meta.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export interface StreamRunner {
  stream: (ctx: RequestContext, body: unknown) => AsyncIterable<Uint8Array>;
  translateResponse: (raw: AsyncIterable<Uint8Array>) => AsyncIterable<ProviderEvent>;
  recoverableError: (err: unknown, ctx: RequestContext, attempt?: number) => RetryDecision;
  getResumeBody?: (ctx: RequestContext, originalBody: unknown) => unknown | null;
}

export type RetryDecision =
  | { kind: "retry"; delayMs?: number; reason?: string }
  | {
      kind: "fail";
      reason: string;
      userMessage?: string;
      quotaExhausted?: boolean;
      quotaResetEpochMs?: number | null;
    };

const DEFAULT_MAX_ATTEMPTS = 10;
export const FORK_MAX_ATTEMPTS = 6;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;

// Shared with tui-observer.ts: what counts as "genuine content" for retry-banner
// visibility (D2) matches what counts as content for resume-vs-reset (this file) —
// the same narrow set of user-visible/generation-bearing kinds. Only accepts a
// bare `kind` field so callers can pass the wider AgentEvent union too.
export function isContentEvent(ev: { kind: string }): boolean {
  return (
    ev.kind === "text_delta" ||
    ev.kind === "thinking_delta" ||
    ev.kind === "tool_call_start" ||
    ev.kind === "tool_call_complete"
  );
}

function maxAttemptsFromEnv(): number {
  const raw = process.env.OTHERSIDE_MAX_RETRIES;
  if (!raw) return DEFAULT_MAX_ATTEMPTS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= 50) return parsed;
  return DEFAULT_MAX_ATTEMPTS;
}

export async function* streamWithRetry(
  ctx: RequestContext,
  provider: StreamRunner,
  buildBody: (() => unknown) | unknown,
  opts?: { maxAttempts?: number; baseDelayMs?: number },
): AsyncIterable<ProviderEvent> {
  const maxAttempts = opts?.maxAttempts ?? maxAttemptsFromEnv();
  const baseDelayMs = opts?.baseDelayMs ?? RETRY_BASE_DELAY_MS;
  const abortSignal = ctx.abortSignal;
  const isBuilder = typeof buildBody === "function";
  let attempts = 0;
  let emittedContent = false;
  let pendingResumeBody: unknown | null = null;
  while (true) {
    if (abortSignal?.aborted) throw new Error("aborted");
    const body =
      pendingResumeBody !== null
        ? pendingResumeBody
        : isBuilder
          ? (buildBody as () => unknown)()
          : buildBody;
    pendingResumeBody = null;
    try {
      const raw = provider.stream(ctx, body);
      for await (const ev of provider.translateResponse(raw)) {
        if (isContentEvent(ev)) emittedContent = true;
        if (ev.kind === "message_start" && ev.requestId === undefined && ctx.responseRequestId) {
          ev.requestId = ctx.responseRequestId;
        }
        yield ev;
      }
      return;
    } catch (err) {
      if (abortSignal?.aborted) throw err;
      // An idle timeout means the connection went quiet, not that it closed:
      // the pool still considers the tunnel healthy and hands it to the retry,
      // which then stalls the same way until the budget drains. Sticky so
      // every remaining attempt of this request bypasses the pool.
      if (err instanceof StreamIdleTimeoutError) ctx.freshConnection = true;
      const decision = provider.recoverableError(err, ctx, attempts + 1);
      const effectiveDecision: RetryDecision = decision;
      if (decision.kind === "retry" && emittedContent) {
        const resumeBody = provider.getResumeBody?.(ctx, body) ?? null;
        if (resumeBody !== null) {
          pendingResumeBody = resumeBody;
        } else {
          // No server-side resume: discard the partial tail everywhere it was
          // accumulated (stream_reset) and re-send the original body. Idempotent —
          // the builder re-assembles from session.messages, which has not committed
          // this turn (the wire committer resets on this same event). Emitted before
          // retry_status so consumers drop partial state before the retry banner.
          yield {
            kind: "stream_reset",
            reason: decision.reason ?? (err instanceof Error ? err.message : String(err)),
            attempt: attempts + 1,
          };
          emittedContent = false;
        }
      }
      if (effectiveDecision.kind === "retry") {
        attempts += 1;
        if (attempts >= maxAttempts) {
          // Exhausting the retry budget on a rate limit is a quota condition,
          // not a generic terminal error: a raw throw here skips provider
          // cooldown and the caller's tier reroute, so the failure surfaces
          // as an opaque `HTTP 429 …` with no recovery. Route it through the
          // same quota_exhausted path the fail branch uses.
          if (err instanceof ProviderHttpError && (err.status === 429 || err.status === 529)) {
            const message = extractBodyMessage(err.body);
            const surfaceMessage =
              message ??
              `Rate limit reached (HTTP ${err.status}) — retries exhausted (${maxAttempts}).`;
            const detailed = classifyProviderError(err, { attempt: attempts });
            const meta = classifyError({
              err,
              decision: detailed,
              provider: ctx.provider,
              model: ctx.model,
              attempt: attempts,
              source: "stream-retry",
            });
            markProviderCooldown(
              ctx.provider,
              null,
              "rate_limited",
              err.status === 429 ? ctx.model : null,
            );
            yield {
              kind: "quota_exhausted",
              provider: ctx.provider,
              model: ctx.model,
              resetEpochMs: err.quotaResetEpochMs,
              message: surfaceMessage,
              meta,
              reason: "rate_limited",
            };
            return;
          }
          throw err;
        }
        const rawBackoff = Math.min(RETRY_MAX_DELAY_MS, baseDelayMs * 2 ** (attempts - 1));
        const delayMs =
          effectiveDecision.kind === "retry" && typeof effectiveDecision.delayMs === "number"
            ? effectiveDecision.delayMs
            : Math.round(rawBackoff * (1 - Math.random() * 0.25));
        const detail = effectiveDecision as { status?: number; message?: string };
        yield {
          kind: "retry_status",
          attempt: attempts,
          maxAttempts,
          delayMs,
          reason: effectiveDecision.reason ?? (err instanceof Error ? err.message : String(err)),
          ...(typeof detail.status === "number" ? { status: detail.status } : {}),
          ...(typeof detail.message === "string" ? { message: detail.message } : {}),
        };
        if (delayMs > 0) {
          await new Promise<void>((resolve, reject) => {
            if (abortSignal?.aborted) {
              reject(new Error("aborted"));
              return;
            }
            let t: ReturnType<typeof setTimeout>;
            const onAbort = () => {
              clearTimeout(t);
              reject(new Error("aborted"));
            };
            t = setTimeout(() => {
              abortSignal?.removeEventListener("abort", onAbort);
              resolve();
            }, delayMs);
            abortSignal?.addEventListener("abort", onAbort, { once: true });
          });
        }
        continue;
      }
      if (effectiveDecision.kind === "fail") {
        const detail = effectiveDecision as {
          userMessage?: string;
          message?: string;
          status?: number;
          quotaExhausted?: boolean;
          quotaResetEpochMs?: number | null;
        };
        const errMsg = err instanceof Error ? err.message : String(err);
        const surfaceMessage = detail.userMessage ?? detail.message ?? errMsg;
        const detailed = classifyProviderError(err, { attempt: attempts + 1 });
        const meta = classifyError({
          err,
          decision: detailed,
          provider: ctx.provider,
          model: ctx.model,
          attempt: attempts + 1,
          source: "stream-retry",
        });
        if (detail.quotaExhausted) {
          const isTransportRateLimit =
            err instanceof ProviderHttpError &&
            err.quotaExhausted === false &&
            (err.status === 429 || err.status === 529);

          if (isTransportRateLimit) {
            markProviderCooldown(
              ctx.provider,
              null,
              "rate_limited",
              err.status === 429 ? ctx.model : null,
            );
            yield {
              kind: "quota_exhausted",
              provider: ctx.provider,
              model: ctx.model,
              resetEpochMs: detail.quotaResetEpochMs ?? null,
              message: surfaceMessage,
              meta,
              reason: "rate_limited",
            };
          } else {
            yield {
              kind: "quota_exhausted",
              provider: ctx.provider,
              model: ctx.model,
              resetEpochMs: detail.quotaResetEpochMs ?? null,
              message: surfaceMessage,
              meta,
              reason: "quota",
            };
          }
          return;
        }
        yield { kind: "error", error: surfaceMessage, meta };
        return;
      }
      throw err;
    }
  }
}
