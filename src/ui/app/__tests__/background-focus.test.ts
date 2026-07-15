import { describe, expect, it } from "bun:test";
import {
  type BackgroundFocusState,
  nextBackgroundFocusDown,
  nextBackgroundFocusUp,
} from "../background-focus.ts";

function focusState(overrides: Partial<BackgroundFocusState> = {}): BackgroundFocusState {
  return {
    hasShellPill: false,
    panelHasRows: false,
    bgPillFocused: false,
    panelFocused: false,
    panelSelection: 0,
    panelMaxIndex: 0,
    ...overrides,
  };
}

describe("background focus navigation", () => {
  it("enters the shell pill before agent rows when both exist", () => {
    const state = focusState({ hasShellPill: true, panelHasRows: true, panelMaxIndex: 2 });

    expect(nextBackgroundFocusDown(state)).toBe("focus-shell-pill");
  });

  it("moves from shell pill into the first panel row", () => {
    const state = focusState({
      hasShellPill: true,
      panelHasRows: true,
      bgPillFocused: true,
      panelMaxIndex: 2,
    });

    expect(nextBackgroundFocusDown(state)).toBe("focus-panel-first");
  });

  it("moves upward from the first panel row back to the shell pill", () => {
    const state = focusState({
      hasShellPill: true,
      panelHasRows: true,
      panelFocused: true,
      panelSelection: 0,
      panelMaxIndex: 2,
    });

    expect(nextBackgroundFocusUp(state)).toBe("focus-shell-pill");
  });

  it("preserves panel-only navigation when there is no shell pill", () => {
    const idle = focusState({ panelHasRows: true, panelMaxIndex: 1 });
    const first = focusState({
      panelHasRows: true,
      panelFocused: true,
      panelSelection: 0,
      panelMaxIndex: 1,
    });

    expect(nextBackgroundFocusDown(idle)).toBe("focus-panel-first");
    expect(nextBackgroundFocusUp(first)).toBe("blur-panel");
  });

  it("keeps shell-only navigation bounded to the shell pill", () => {
    const idle = focusState({ hasShellPill: true });
    const focused = focusState({ hasShellPill: true, bgPillFocused: true });

    expect(nextBackgroundFocusDown(idle)).toBe("focus-shell-pill");
    expect(nextBackgroundFocusDown(focused)).toBe("none");
    expect(nextBackgroundFocusUp(focused)).toBe("blur-shell-pill");
  });
});
