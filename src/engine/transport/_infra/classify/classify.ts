import { getProviderConfig } from "@/engine/contract/registry.ts";
import {
  formatProviderError,
  resolveProviderError,
} from "@/engine/providers/_shared/provider-error.ts";
import { getRetryDelay, ProviderHttpError } from "@/engine/providers/_shared/retry.ts";
import { StreamSilenceError } from "@/kernel/std/stream/idle-timeout.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";

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
  if (error instanceof StreamSilenceError) {
    const reason = `${error.scope} stream idle ${error.silenceMs}ms`;
    // Keepalives prove the connection is alive, so content silence means the
    // model itself is wedged. Without that proof, the content deadline may fire
    // before the quiet-provider byte deadline and reconnecting can recover.
    if (
      error.scope === "content" &&
      options.provider !== undefined &&
      getProviderConfig(options.provider as ProviderId)?.streamEmitsKeepalive === true
    ) {
      const abortReason = `${reason} — aborting (live connection, no model output)`;
      return {
        kind: "fail",
        reason: abortReason,
        userMessage: abortReason,
        message: abortReason,
      };
    }
    return {
      kind: "retry",
      delayMs: getRetryDelay(attempt),
      reason: `${reason} — reconnecting`,
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
