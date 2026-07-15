const CHECK_INTERVAL_MS = 200;
const STALL_THRESHOLD_MS = 500;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let lastCheck = 0;
const subscribers = new Set<(stallMs: number) => void>();

export function startEventLoopStallDetector(): void {
  if (intervalHandle !== null) return;
  lastCheck = Date.now();
  intervalHandle = setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastCheck;
    const stallMs = elapsed - CHECK_INTERVAL_MS;
    if (stallMs > STALL_THRESHOLD_MS) {
      for (const fn of subscribers) {
        try {
          fn(stallMs);
        } catch {}
      }
    }
    lastCheck = now;
  }, CHECK_INTERVAL_MS);
  intervalHandle.unref?.();
}

export function onEventLoopStall(callback: (stallMs: number) => void): () => void {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}
