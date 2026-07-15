// Quota endpoints are best-effort side channels; a hung fetch must never wedge the UI or snapshot fan-outs.
export const USAGE_FETCH_TIMEOUT_MS = 10_000;

export function usageFetchSignal(): AbortSignal {
  return AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS);
}
