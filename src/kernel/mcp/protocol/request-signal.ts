import { REQUEST_TIMEOUT_MS } from "@/kernel/mcp/protocol/constants.ts";
import { AbortError } from "@/kernel/std/stream/abort.ts";

/** Deadline alone, or deadline raced against a turn-owned signal. */
export function mcpRequestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Rejects a pending stdio/sse id when the turn signal fires. The caller must
 * already have refused a pre-aborted signal; this only attaches. Returns a
 * cleanup that drops the listener after the request settles on its own.
 */
export function rejectPendingOnAbort(
  signal: AbortSignal | undefined,
  reject: (error: Error) => void,
): () => void {
  if (!signal) return () => {};
  const onAbort = (): void => reject(new AbortError());
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}
