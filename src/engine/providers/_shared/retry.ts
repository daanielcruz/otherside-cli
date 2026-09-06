import {
  isRetryableNetworkError,
  parseRetryAfterHeader,
  RETRY_AFTER_TOO_LONG_MS,
  resolveProviderError,
} from "@/engine/providers/_shared/provider-error.ts";
import { ProviderHttpError, QuotaExhaustedError } from "@/kernel/std/types/error-meta.ts";

export {
  isRetryableNetworkError,
  ProviderHttpError,
  parseRetryAfterHeader,
  QuotaExhaustedError,
  RETRY_AFTER_TOO_LONG_MS,
};

export const BASE_DELAY_MS = 500;
export const DEFAULT_MAX_DELAY_MS = 32_000;
export const DEFAULT_MAX_ATTEMPTS = 10;

export function getRetryDelay(
  attempt: number,
  retryAfterMs: number | null = null,
  maxDelayMs: number = DEFAULT_MAX_DELAY_MS,
  baseDelayMs: number = BASE_DELAY_MS,
): number {
  const safeAttempt = Math.max(1, attempt);
  const baseDelay = Math.min(baseDelayMs * 2 ** (safeAttempt - 1), maxDelayMs);
  const backoffMs = baseDelay + Math.random() * 0.25 * baseDelay;
  return Math.max(retryAfterMs ?? 0, backoffMs);
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
  const reason = input.reason ?? `HTTP ${input.status}`;
  const classified = resolveProviderError({
    provider: "provider",
    status: input.status,
    headers: {
      ...(input.shouldRetryHeader !== undefined
        ? { "x-should-retry": input.shouldRetryHeader }
        : {}),
    },
    ...(input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
  });
  if (!classified.retryable) return { kind: "fail", reason };
  return {
    kind: "retry",
    delayMs: getRetryDelay(input.attempt, classified.retryAfterMs ?? null),
    reason,
  };
}

export function streamErrorToHttpError(opts: {
  provider: string;
  rawBody: string;
  fallbackStatus?: number;
}): ProviderHttpError {
  const classified = resolveProviderError({
    provider: opts.provider,
    ...(opts.fallbackStatus !== undefined ? { status: opts.fallbackStatus } : {}),
    body: opts.rawBody,
  });
  return new ProviderHttpError({
    provider: opts.provider,
    status: classified.status ?? opts.fallbackStatus ?? 500,
    body: opts.rawBody,
    quotaExhausted: classified.class === "quota_exhausted",
    quotaResetEpochMs: classified.quotaResetEpochMs ?? null,
  });
}

export interface QuotaDetectInput {
  provider?: string;
  status: number;
  headers?: Headers | Record<string, string | null | undefined>;
  body?: string;
  retryAfterMs?: number | null;
}

export function detectQuotaExhaustion(input: QuotaDetectInput): {
  quotaExhausted: boolean;
  resetEpochMs: number | null;
} {
  const classified = resolveProviderError({
    provider: input.provider ?? "provider",
    status: input.status,
    ...(input.headers !== undefined ? { headers: input.headers } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
  });
  return {
    quotaExhausted: classified.class === "quota_exhausted",
    resetEpochMs: classified.quotaResetEpochMs ?? null,
  };
}

export function extractBodyMessage(body: string): string | null {
  if (!body) return null;
  const classified = resolveProviderError({ provider: "provider", body });
  return classified.detail === "unknown error" ? null : classified.detail;
}

export function extractHttpStatus(error: unknown): number | null {
  return resolveProviderError({ provider: "provider", error }).status ?? null;
}
