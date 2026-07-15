import { useContext, useMemo, useRef, useSyncExternalStore } from "react";
import { RENDER_CYCLE_INTERVAL_MS } from "@/terminal-runtime/host/timing.js";
import { TimekeeperContext } from "@/terminal-runtime/react/time-source.js";

const noopSubscribe = (): (() => void) => () => {};
const nullSnapshot = (): null => null;

export function useTimelineElapsed(intervalMs: number | null): number {
  const clock = useContext(TimekeeperContext);
  const quantum =
    intervalMs === null
      ? null
      : Math.ceil(intervalMs / RENDER_CYCLE_INTERVAL_MS) * RENDER_CYCLE_INTERVAL_MS;
  const lastNowRef = useRef<number | null>(null);
  const subscribe = useMemo(() => {
    if (!clock || quantum === null) return noopSubscribe;
    return (onStoreChange: () => void) =>
      clock.subscribeFollower(() => {
        lastNowRef.current = clock.now();
        onStoreChange();
      });
  }, [clock, quantum]);
  return useSyncExternalStore(subscribe, () => {
    if (!clock || quantum === null) {
      lastNowRef.current = null;
      return 0;
    }
    if (lastNowRef.current === null) lastNowRef.current = clock.now();
    return Math.floor(lastNowRef.current / quantum) * quantum;
  });
}

export function useRepeatingClock(
  callback: () => void,
  intervalMs: number | null,
  options?: { immediate?: boolean },
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const clock = useContext(TimekeeperContext);
  const immediate = options?.immediate ?? false;
  const lastDelayRef = useRef<number | null>(null);

  const subscribe = useMemo(() => {
    if (!clock || intervalMs === null) {
      return (): (() => void) => {
        lastDelayRef.current = null;
        return () => {};
      };
    }
    return (): (() => void) => {
      if (immediate && lastDelayRef.current === null) callbackRef.current();
      lastDelayRef.current = intervalMs;
      let cancelled = false;
      let cancelTimer: (() => void) | undefined;
      const fire = (): void => {
        if (cancelled) return;
        try {
          callbackRef.current();
        } finally {
          if (!cancelled) cancelTimer = clock.setTimeout(fire, intervalMs);
        }
      };
      cancelTimer = clock.setTimeout(fire, intervalMs);
      return () => {
        cancelled = true;
        cancelTimer?.();
      };
    };
  }, [clock, intervalMs, immediate]);

  useSyncExternalStore(subscribe, nullSnapshot);
}
