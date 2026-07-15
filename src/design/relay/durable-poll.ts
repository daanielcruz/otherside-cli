export const DESIGN_EVENT_POLL_INTERVAL_MS = 5_000;

export function startDurablePoll(
  poll: () => void | Promise<void>,
  intervalMs = DESIGN_EVENT_POLL_INTERVAL_MS,
): () => void {
  void poll();
  const timer = setInterval(() => void poll(), intervalMs);
  return () => clearInterval(timer);
}
