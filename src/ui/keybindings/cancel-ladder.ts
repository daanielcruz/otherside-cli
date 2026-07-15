export type CancellationKey = "ctrl-c" | "esc";

export type CancellationStage = 1 | 2 | 3 | 4 | 5 | 6;

export interface CancellationState {
  panelOpen: boolean;
  hasPromptText: boolean;
  queueLength: number;
  turnRunning: boolean;
  exitArmed: boolean;
}

export interface CancellationActions {
  closePanel: () => void;
  clearPromptText: () => void;
  restoreQueuedToPrompt: () => void;
  cancelTurn: () => void;
  armExitHint: () => void;
  exit: () => void;
}

export function dispatchCancellation(
  key: CancellationKey,
  state: CancellationState,
  actions: CancellationActions,
): CancellationStage | null {
  if (state.panelOpen) {
    actions.closePanel();
    return 1;
  }
  if (state.hasPromptText) {
    actions.clearPromptText();
    return 2;
  }
  if (state.turnRunning) {
    actions.cancelTurn();
    return 4;
  }
  if (state.queueLength > 0) {
    actions.restoreQueuedToPrompt();
    return 3;
  }
  if (key !== "ctrl-c") return null;
  if (state.exitArmed) {
    actions.exit();
    return 6;
  }
  actions.armExitHint();
  return 5;
}
