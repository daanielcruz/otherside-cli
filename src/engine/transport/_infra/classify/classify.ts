import {
  classifyHttpStatus,
  extractBodyMessage,
  getRetryDelay,
  isTransientNetworkError,
  ProviderHttpError,
  parseRetryAfterHeader,
  RETRY_AFTER_TOO_LONG_MS,
} from "@/engine/providers/_shared/retry.ts";
import { StreamIdleTimeoutError } from "@/kernel/std/stream/idle-timeout.ts";

export interface ClassifyOptions {
  attempt?: number;
  terminalReasons?: (err: ProviderHttpError) => string | null;
}

export type RetryDecisionDetailed =
  | {
      kind: "retry";
      delayMs: number;
      reason: string;
      status?: number;
      message?: string;
    }
  | {
      kind: "fail";
      reason: string;
      userMessage?: string;
      status?: number;
      message?: string;
      quotaExhausted?: boolean;
      quotaResetEpochMs?: number | null;
    };

const CONTEXT_WINDOW_PATTERNS: RegExp[] = [
  /exceeds the context window/i,
  /context length/i,
  /context_length_exceeded/i,
  /prompt is too long/i,
  /maximum context length/i,
  /input is too long/i,
  /reduce the length/i,
];

export function isContextWindowExceeded(err: unknown): boolean {
  if (!(err instanceof ProviderHttpError)) return false;
  if (err.status !== 400 && err.status !== 413) return false;
  const haystack = `${err.message} ${err.body}`;
  return CONTEXT_WINDOW_PATTERNS.some((re) => re.test(haystack));
}

export function classifyProviderError(
  err: unknown,
  options: ClassifyOptions = {},
): RetryDecisionDetailed {
  const attempt = options.attempt ?? 1;

  if (err instanceof StreamIdleTimeoutError) {
    return {
      kind: "retry",
      delayMs: getRetryDelay(attempt),
      reason: `${err.kind} stream idle ${err.idleMs}ms — reconnecting`,
    };
  }

  if (err instanceof ProviderHttpError) {
    if (isContextWindowExceeded(err)) {
      const message = extractBodyMessage(err.body) ?? "provider context window exceeded";
      return {
        kind: "fail",
        reason: "context_window_exceeded",
        userMessage: `${message}\nRun /compact, switch to a model with a larger context window, or start a new session.`,
        status: err.status,
        message,
      };
    }
    const terminalMsg = options.terminalReasons?.(err);
    if (terminalMsg) {
      return {
        kind: "fail",
        reason: terminalMsg,
        userMessage: terminalMsg,
        status: err.status,
        message: extractBodyMessage(err.body) ?? terminalMsg,
      };
    }
    const retryAfterMs = parseRetryAfterHeader(err.retryAfterHeader);
    const message = extractBodyMessage(err.body);
    if (err.quotaExhausted) {
      return {
        kind: "fail",
        reason: "quota_exhausted",
        userMessage:
          message ?? `Quota exhausted (HTTP ${err.status}). Switch model or quit and try later.`,
        status: err.status,
        quotaExhausted: true,
        quotaResetEpochMs: err.quotaResetEpochMs,
        ...(message ? { message } : {}),
      };
    }
    const decision = classifyHttpStatus({
      status: err.status,
      attempt,
      retryAfterMs,
      shouldRetryHeader: err.shouldRetryHeader,
      reason: err.message,
    });
    if (
      decision.kind === "fail" &&
      retryAfterMs !== null &&
      retryAfterMs > RETRY_AFTER_TOO_LONG_MS
    ) {
      const minutes = Math.ceil(retryAfterMs / 60_000);
      const userMessage = `Rate limit reached (HTTP ${err.status}). Server asks to wait ${minutes} minute${minutes === 1 ? "" : "s"} before retrying — try again later or switch provider/model.`;
      return {
        kind: "fail",
        reason: decision.reason,
        userMessage,
        status: err.status,
        quotaExhausted: true,
        quotaResetEpochMs: Date.now() + retryAfterMs,
        ...(message ? { message } : {}),
      };
    }
    // A non-retryable rate limit (429/529 that classifyHttpStatus refused to
    // retry — e.g. `x-should-retry: false` with a body matching no quota
    // pattern) is still a hard rate limit: without the quotaExhausted stamp
    // it dies as a raw terminal error, skipping provider cooldown and the
    // fork tier reroute entirely.
    if (decision.kind === "fail" && (err.status === 429 || err.status === 529)) {
      return {
        kind: "fail",
        reason: decision.reason,
        userMessage:
          message ??
          `Rate limit reached (HTTP ${err.status}). Try again later or switch provider/model.`,
        status: err.status,
        quotaExhausted: true,
        quotaResetEpochMs: retryAfterMs !== null ? Date.now() + retryAfterMs : null,
        ...(message ? { message } : {}),
      };
    }
    return { ...decision, status: err.status, ...(message ? { message } : {}) };
  }

  if (isTransientNetworkError(err)) {
    return {
      kind: "retry",
      delayMs: getRetryDelay(attempt),
      reason: errorReason(err) ?? "transient network error",
    };
  }

  return {
    kind: "fail",
    reason: errorReason(err) ?? String(err),
  };
}

function errorReason(err: unknown): string | null {
  if (err instanceof Error && err.message.length > 0) return err.message;
  if (err && typeof err === "object") {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m.length > 0) return m;
  }
  return null;
}
