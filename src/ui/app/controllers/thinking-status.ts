import { createAutoClearDispatch } from "@/kernel/std/state/auto-clear-dispatch.ts";
import { dispatch } from "@/store/app-store/index.ts";

/** Reasoning shorter than this is not worth reporting — it reads as a flicker. */
const SHOW_DURATION_THRESHOLD_MS = 2_000;
/** How long the finished duration stays on screen before the row goes quiet. */
const DURATION_CLEAR_DELAY_MS = 2_000;

export interface ThinkingStatusController {
  /** Reasoning started streaming: the row says so until it stops. */
  readonly begin: () => void;
  /** Reasoning stopped: the row reports how long it took, then falls silent. */
  readonly end: () => void;
  /** The turn is over or was cut short; the row has nothing to report. */
  readonly reset: () => void;
}

/**
 * Drives the reasoning readout on the progress row. A short burst still holds the
 * screen for the threshold before its duration appears, so the reader gets a chance to
 * see it rather than a number that flashes past.
 */
export function createThinkingStatusController(): ThinkingStatusController {
  const holdFinished = createAutoClearDispatch({ holdMs: DURATION_CLEAR_DELAY_MS });
  let startedAt: number | null = null;
  let pending: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = (): void => {
    if (pending !== null) {
      clearTimeout(pending);
      pending = null;
    }
    holdFinished.clear();
  };

  const report = (status: "thinking" | number | null): void => {
    dispatch({ type: "view/setThinkingStatus", status });
  };

  const reset = (): void => {
    clearTimers();
    startedAt = null;
    report(null);
  };

  const begin = (): void => {
    clearTimers();
    if (startedAt !== null) return;
    startedAt = Date.now();
    report("thinking");
  };

  const end = (): void => {
    if (startedAt === null) return;
    const elapsedMs = Date.now() - startedAt;
    startedAt = null;
    const showDuration = (): void => {
      pending = null;
      report(elapsedMs);
      holdFinished.arm({ onTimeout: () => report(null) });
    };
    const remaining = Math.max(0, SHOW_DURATION_THRESHOLD_MS - elapsedMs);
    if (remaining === 0) showDuration();
    else pending = setTimeout(showDuration, remaining);
  };

  return { begin, end, reset };
}
