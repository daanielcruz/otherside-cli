import { useCallback, useEffect, useMemo, useRef } from "react";
import { createAutoClearDispatch } from "@/kernel/std/state/auto-clear-dispatch.ts";
import { dispatch } from "@/store/index.ts";

const SHOW_DURATION_THRESHOLD_MS = 2000;
const DURATION_CLEAR_DELAY_MS = 2000;

type DurationTimerRef = ReturnType<typeof setTimeout> | null;

export interface ThinkingStatusController {
  readonly begin: () => void;
  readonly end: () => void;
  readonly reset: () => void;
}

export function useThinkingStatusController(): ThinkingStatusController {
  const startRef = useRef<number | null>(null);
  const durationTimerRef = useRef<DurationTimerRef>(null);
  const clearDispatch = useMemo(
    () => createAutoClearDispatch({ holdMs: DURATION_CLEAR_DELAY_MS }),
    [],
  );

  const clearTimers = useCallback((): void => {
    if (durationTimerRef.current !== null) {
      clearTimeout(durationTimerRef.current);
      durationTimerRef.current = null;
    }
    clearDispatch.clear();
  }, [clearDispatch]);

  const reset = useCallback((): void => {
    clearTimers();
    startRef.current = null;
    dispatch({ type: "view/setThinkingStatus", status: null });
  }, [clearTimers]);

  const begin = useCallback((): void => {
    clearTimers();
    if (startRef.current !== null) return;
    startRef.current = Date.now();
    dispatch({ type: "view/setThinkingStatus", status: "thinking" });
  }, [clearTimers]);

  const end = useCallback((): void => {
    const started = startRef.current;
    if (started === null) return;
    const duration = Date.now() - started;
    const remaining = Math.max(0, SHOW_DURATION_THRESHOLD_MS - duration);
    startRef.current = null;
    const showDuration = (): void => {
      durationTimerRef.current = null;
      dispatch({ type: "view/setThinkingStatus", status: duration });
      clearDispatch.arm({
        onTimeout: () => dispatch({ type: "view/setThinkingStatus", status: null }),
      });
    };
    if (remaining > 0) {
      durationTimerRef.current = setTimeout(showDuration, remaining);
    } else {
      showDuration();
    }
  }, [clearDispatch]);

  useEffect(() => {
    return () => clearTimers();
  }, [clearTimers]);

  return { begin, end, reset };
}
