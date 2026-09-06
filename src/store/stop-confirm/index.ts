import { makeStore, type Store } from "@/kernel/std/state/make-store.ts";

/**
 * Armed close confirmation for a panel agent row. The first stop press arms the
 * row; a second press within the hold closes it. The hold expiring, or the
 * cursor leaving the row, disarms.
 */
export interface StopConfirmState {
  readonly taskId: string | null;
  /** Whether the arming press also stopped a live run (changes the row's message). */
  readonly justStopped: boolean;
}

const STOP_CONFIRM_HOLD_MS = 3_000;
let holdMs = STOP_CONFIRM_HOLD_MS;
let holdTimer: ReturnType<typeof setTimeout> | undefined;

const initial: StopConfirmState = { taskId: null, justStopped: false };

export const stopConfirmStore: Store<StopConfirmState> = makeStore<StopConfirmState>(initial);

export function armStopConfirm(taskId: string, justStopped: boolean): void {
  if (holdTimer !== undefined) clearTimeout(holdTimer);
  holdTimer = setTimeout(() => clearStopConfirm(), holdMs);
  (holdTimer as { unref?: () => void }).unref?.();
  stopConfirmStore.setState(() => ({ taskId, justStopped }));
}

export function clearStopConfirm(): void {
  if (holdTimer !== undefined) clearTimeout(holdTimer);
  holdTimer = undefined;
  stopConfirmStore.setState((prev) => (prev.taskId === null ? prev : initial));
}

export function armedStopTaskId(): string | null {
  return stopConfirmStore.getState().taskId;
}

export function setStopConfirmHoldForTests(ms: number): void {
  holdMs = ms;
}
