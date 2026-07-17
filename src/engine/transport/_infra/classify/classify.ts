import {
  formatProviderError,
  resolveProviderError,
} from "@/engine/providers/_shared/provider-error.ts";
import { getRetryDelay, ProviderHttpError } from "@/engine/providers/_shared/retry.ts";
import { StreamIdleTimeoutError } from "@/kernel/std/stream/idle-timeout.ts";

export interface ClassifyOptions {
  attempt?: number;
  provider?: string;
  model?: string;
  terminalReasons?: (error: ProviderHttpError) => string | null;
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

export function isContextWindowExceeded(error: unknown): boolean {
  if (!(error instanceof ProviderHttpError)) return false;
  return (
    resolveProviderError({
      provider: error.provider,
      status: error.status,
      body: error.body,
      error,
    }).class === "context_overflow"
  );
}

export function classifyProviderError(
  error: unknown,
  options: ClassifyOptions = {},
): RetryDecisionDetailed {
  const attempt = options.attempt ?? 1;
  if (error instanceof StreamIdleTimeoutError) {
    return {
      kind: "retry",
      delayMs: getRetryDelay(attempt),
      reason: `${error.kind} stream idle ${error.idleMs}ms — reconnecting`,
    };
  }

  if (error instanceof ProviderHttpError) {
    const terminalReason = options.terminalReasons?.(error);
    if (terminalReason) {
      return {
        kind: "fail",
        reason: terminalReason,
        userMessage: terminalReason,
        status: error.status,
        message: terminalReason,
      };
    }
  }

  const classified = resolveProviderError({
    provider:
      options.provider ?? (error instanceof ProviderHttpError ? error.provider : "provider"),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(error instanceof ProviderHttpError
      ? {
          status: error.status,
          body: error.body,
          headers: error.headers,
        }
      : {}),
    error,
  });
  const formatted = formatProviderError(classified);

  if (classified.retryable) {
    return {
      kind: "retry",
      delayMs: getRetryDelay(attempt, classified.retryAfterMs ?? null),
      reason: formatted,
      ...(classified.status !== undefined ? { status: classified.status } : {}),
      message: classified.detail,
    };
  }

  if (classified.class === "context_overflow") {
    return {
      kind: "fail",
      reason: "context_window_exceeded",
      userMessage: `${classified.detail}\nRun /compact, switch to a model with a larger context window, or start a new session.`,
      ...(classified.status !== undefined ? { status: classified.status } : {}),
      message: classified.detail,
    };
  }

  if (classified.class === "quota_exhausted") {
    return {
      kind: "fail",
      reason: "quota_exhausted",
      userMessage: formatted,
      ...(classified.status !== undefined ? { status: classified.status } : {}),
      message: classified.detail,
      quotaExhausted: true,
      quotaResetEpochMs: classified.quotaResetEpochMs ?? null,
    };
  }

  return {
    kind: "fail",
    reason: classified.detail,
    userMessage: formatted,
    ...(classified.status !== undefined ? { status: classified.status } : {}),
    message: classified.detail,
  };
}
