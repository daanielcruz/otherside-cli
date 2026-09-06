import {
  beginPromptCacheAttempt,
  finishPromptCacheAttempt,
  recordPromptCacheEvent,
} from "@/devtools/prompt-cache.ts";
import type { ProviderStreamAttempt, RetryDecision } from "@/engine/contract/types.ts";
import {
  formatProviderError,
  resolveProviderError,
} from "@/engine/providers/_shared/provider-error.ts";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_DELAY_MS,
  getRetryDelay,
} from "@/engine/providers/_shared/retry.ts";
import { markProviderCooldown } from "@/engine/session/usage/provider-health.ts";
import { classifyProviderError } from "@/engine/transport/_infra/classify/classify.ts";
import { classifyError } from "@/engine/transport/_infra/classify/error-classifier.ts";
import { StreamSilenceError } from "@/kernel/std/stream/idle-timeout.ts";
import { ProviderHttpError } from "@/kernel/std/types/error-meta.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export interface StreamRunner {
  startStreamAttempt: (ctx: RequestContext, body: unknown) => ProviderStreamAttempt;
  recoverableError: (err: unknown, ctx: RequestContext, attempt?: number) => RetryDecision;
  getResumeBody?: (ctx: RequestContext, originalBody: unknown) => unknown | null;
}

export { DEFAULT_MAX_ATTEMPTS };

export const DEFAULT_RETRY_BUDGET_MS = 180_000;
export const SIDE_QUESTION_MAX_ATTEMPTS = 6;

// Silence detection spends its whole deadline observing the quiet stream, so
// the elapsed budget can drain before the first reconnect ever runs. Silent
// streams therefore keep a guaranteed retry floor, and reconnect promptly —
// a dead socket gains nothing from exponential backoff.
export const STREAM_SILENCE_MIN_ATTEMPTS = 3;
export const STREAM_SILENCE_RETRY_DELAY_MS = 1_000;

export function retryBudgetExhausted(input: {
  attempts: number;
  maxAttempts: number;
  elapsedMs: number;
  nextDelayMs: number;
  maxElapsedMs: number;
  minAttempts?: number;
}): boolean {
  if (input.attempts >= input.maxAttempts) return true;
  if (input.attempts < (input.minAttempts ?? 0)) return false;
  return input.elapsedMs + input.nextDelayMs > input.maxElapsedMs;
}

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
  opts?: { maxAttempts?: number; baseDelayMs?: number; maxElapsedMs?: number },
): AsyncIterable<ProviderEvent> {
  const maxAttempts = opts?.maxAttempts ?? maxAttemptsFromEnv();
  const baseDelayMs = opts?.baseDelayMs;
  const maxElapsedMs = opts?.maxElapsedMs ?? DEFAULT_RETRY_BUDGET_MS;
  // Anchors the elapsed retry budget. Restamped whenever a failing attempt had
  // already produced content: the budget exists to stop hopeless thrashing, and
  // a stream that ran successfully for longer than the budget must not arrive
  // at its first disconnect with every retry already spent.
  let retryWindowStartedAt = Date.now();
  const abortSignal = ctx.abortSignal;
  const isBuilder = typeof buildBody === "function";
  let attempts = 0;
  let emittedContent = false;
  let pendingResumeBody: unknown | null = null;
  while (true) {
    if (abortSignal?.aborted) throw new Error("aborted");
    const resumed = pendingResumeBody !== null;
    const body = resumed
      ? pendingResumeBody
      : isBuilder
        ? (buildBody as () => unknown)()
        : buildBody;
    pendingResumeBody = null;
    const cacheAttempt = beginPromptCacheAttempt({
      ctx,
      body,
      attempt: attempts + 1,
      resumed,
    });
    let streamAttempt: ProviderStreamAttempt | null = null;
    let streamCompleted = false;
    let attemptProgressed = false;
    try {
      streamAttempt = provider.startStreamAttempt(ctx, body);
      for await (const ev of streamAttempt.events) {
        if (isContentEvent(ev)) {
          emittedContent = true;
          attemptProgressed = true;
        }
        if (ev.kind === "message_start" && ev.requestId === undefined && ctx.responseRequestId) {
          ev.requestId = ctx.responseRequestId;
        }
        recordPromptCacheEvent(cacheAttempt, ev);
        yield ev;
      }
      streamCompleted = true;
      finishPromptCacheAttempt(cacheAttempt, "completed");
      return;
    } catch (err) {
      streamAttempt?.abort(err);
      finishPromptCacheAttempt(cacheAttempt, abortSignal?.aborted ? "aborted" : "transport_error");
      if (abortSignal?.aborted) throw err;
      // An idle timeout means the connection went quiet, not that it closed:
      // the pool still considers the tunnel healthy and hands it to the retry,
      // which then stalls the same way until the budget drains. Sticky so
      // every remaining attempt of this request bypasses the pool.
      if (err instanceof StreamSilenceError) ctx.freshConnection = true;
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
        const silentStream = err instanceof StreamSilenceError;
        const delayMs = silentStream
          ? STREAM_SILENCE_RETRY_DELAY_MS
          : typeof effectiveDecision.delayMs === "number"
            ? effectiveDecision.delayMs
            : getRetryDelay(attempts, null, DEFAULT_MAX_DELAY_MS, baseDelayMs);
        // A failing attempt that made progress proves the route works, so the
        // retry window restarts instead of charging the streaming time to it.
        if (attemptProgressed) retryWindowStartedAt = Date.now();
        const elapsedMs = Date.now() - retryWindowStartedAt;
        if (
          retryBudgetExhausted({
            attempts,
            maxAttempts,
            elapsedMs,
            nextDelayMs: delayMs,
            maxElapsedMs,
            ...(silentStream ? { minAttempts: STREAM_SILENCE_MIN_ATTEMPTS } : {}),
          })
        ) {
          const classified = resolveProviderError({
            provider: ctx.provider,
            model: ctx.model,
            ...(err instanceof ProviderHttpError
              ? {
                  status: err.status,
                  body: err.body,
                  headers: {
                    "retry-after": err.retryAfterHeader,
                    "x-should-retry": err.shouldRetryHeader,
                  },
                }
              : {}),
            error: err,
          });
          const surfaceMessage = formatProviderError(classified, {
            retries: Math.max(0, attempts - 1),
            elapsedMs,
          });
          const detailed = classifyProviderError(err, {
            attempt: attempts,
            provider: ctx.provider,
            model: ctx.model,
          });
          const meta = classifyError({
            err,
            decision: detailed,
            provider: ctx.provider,
            model: ctx.model,
            attempt: attempts,
            source: "stream-retry",
          });
          if (classified.class === "rate_limit" || classified.class === "overloaded") {
            markProviderCooldown(
              ctx.provider,
              null,
              "rate_limited",
              classified.class === "rate_limit" ? ctx.model : null,
            );
            yield {
              kind: "quota_exhausted",
              provider: ctx.provider,
              model: ctx.model,
              resetEpochMs: err instanceof ProviderHttpError ? err.quotaResetEpochMs : null,
              message: surfaceMessage,
              meta,
              reason: "rate_limited",
            };
            return;
          }
          throw new Error(surfaceMessage, { cause: err });
        }
        const detail = effectiveDecision as {
          status?: number;
          message?: string;
        };
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
        const detailed = classifyProviderError(err, {
          attempt: attempts + 1,
          provider: ctx.provider,
          model: ctx.model,
        });
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
    } finally {
      if (!streamCompleted) {
        streamAttempt?.abort(abortSignal?.reason ?? new Error("stream attempt stopped"));
      }
      if (cacheAttempt && !cacheAttempt.finished) {
        finishPromptCacheAttempt(
          cacheAttempt,
          abortSignal?.aborted || cacheAttempt.stopReason === undefined ? "aborted" : "completed",
        );
      }
    }
  }
}
