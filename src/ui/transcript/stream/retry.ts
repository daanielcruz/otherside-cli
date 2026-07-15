import type { RetryStatusLine } from "@/store/app-store/slices/view.ts";

export const RATE_LIMIT_PATTERN = /rate[_-]limit|usage limit|HTTP 429/i;

export type { RetryStatusLine };

export function retryCountdownDeadline(startedAt: number, initialSeconds: number): number | null {
  if (startedAt <= 0 || initialSeconds <= 0) return null;
  return startedAt + initialSeconds * 1000;
}

export function isRetryCountdownSettled(deadline: number | null, atMs: number): boolean {
  return deadline !== null && atMs >= deadline;
}
