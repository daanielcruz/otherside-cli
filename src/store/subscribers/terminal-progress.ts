import { appStore } from "@/store/app-store/index.ts";
import { emitTerminalProgress } from "@/terminal-runtime";

/**
 * Mirrors the turn's busy state onto the terminal's native progress surface
 * (OSC 9;4): busy paints the indeterminate bar, idle clears it. Support and
 * enablement gates live inside emitTerminalProgress.
 */
export function startTerminalProgressSubscriber(
  emit: typeof emitTerminalProgress = emitTerminalProgress,
): () => void {
  let lastBusy = appStore.getState().view.busy;

  const unsubscribe = appStore.subscribe(() => {
    const busy = appStore.getState().view.busy;
    if (busy === lastBusy) return;
    lastBusy = busy;
    emit(busy ? "indeterminate" : "completed");
  });

  return () => {
    unsubscribe();
    emit("completed");
  };
}
