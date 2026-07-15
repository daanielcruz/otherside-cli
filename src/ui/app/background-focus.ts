export type BackgroundFocusAction =
  | "none"
  | "focus-shell-pill"
  | "blur-shell-pill"
  | "focus-panel-first"
  | "next-panel-row"
  | "previous-panel-row"
  | "blur-panel";

export interface BackgroundFocusState {
  hasShellPill: boolean;
  panelHasRows: boolean;
  bgPillFocused: boolean;
  panelFocused: boolean;
  panelSelection: number;
  panelMaxIndex: number;
}

export function nextBackgroundFocusDown(state: BackgroundFocusState): BackgroundFocusAction {
  if (state.bgPillFocused) {
    if (state.panelHasRows) return "focus-panel-first";
    return "none";
  }
  if (!state.panelFocused) {
    if (state.hasShellPill) return "focus-shell-pill";
    if (state.panelHasRows) return "focus-panel-first";
    return "none";
  }
  if (state.panelSelection < state.panelMaxIndex) return "next-panel-row";
  return "none";
}

export function nextBackgroundFocusUp(state: BackgroundFocusState): BackgroundFocusAction {
  if (state.bgPillFocused) return "blur-shell-pill";
  if (!state.panelFocused) return "none";
  if (state.panelSelection === 0) {
    if (state.hasShellPill) return "focus-shell-pill";
    return "blur-panel";
  }
  return "previous-panel-row";
}
