import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appStore, dispatch } from "@/store/app-store/index.ts";
import { setPromptSearch, setPromptText } from "@/store/prompt/index.ts";
import { reportWindowAttention } from "@/store/window-attention/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import type {
  StringComponent,
  StringViewContext,
} from "@/terminal-runtime/string-view/component.ts";
import type { StringFocusTarget } from "@/terminal-runtime/string-view/focus.ts";
import { StringViewPrompt } from "@/ui/input/string-view-prompt.ts";

const WIDTH = 40;
const INVERSE_ON = "\x1b[7m";

let prompt: StringViewPrompt;
let focusHolder: StringFocusTarget | undefined;
const initialAppState = appStore.getState();

/** The prompt's own row — the one carrying the chevron and the typed text. */
function inputRow(component: StringComponent): string {
  const rows = component.render(WIDTH);
  return rows.find((row) => row.includes("hello")) ?? "";
}

beforeEach(() => {
  appStore.setState(() => initialAppState);
  setPromptText("");
  setPromptSearch(null);
  reportWindowAttention(true);
  focusHolder = undefined;
  const context: StringViewContext = {
    requestRender() {},
    pushFocus(target) {
      focusHolder = target;
    },
    popFocus() {},
    currentFocus: () => focusHolder,
  };
  prompt = new StringViewPrompt();
  prompt.mount(context);
  setPromptText("hello");
});

afterEach(() => {
  prompt.unmount();
  appStore.setState(() => initialAppState);
  setPromptText("");
  setPromptSearch(null);
  reportWindowAttention(true);
});

describe("the caret only lights where typing would land", () => {
  it("inverts the caret cell while the prompt holds focus in a focused window", () => {
    expect(inputRow(prompt)).toContain(INVERSE_ON);
  });

  it("drops the inversion when the window loses focus, keeping the row's width", () => {
    const lit = inputRow(prompt);
    reportWindowAttention(false);
    const unlit = inputRow(prompt);

    expect(unlit).not.toContain(INVERSE_ON);
    expect(unlit).toContain("hello");
    // Only the styling goes: the caret cell still occupies its column.
    expect(stripStyles(unlit)).toBe(stripStyles(lit));
  });

  it("drops the inversion while another surface owns the keys", () => {
    const panel: StringFocusTarget = { handleKey: () => true };
    focusHolder = panel;

    expect(inputRow(prompt)).not.toContain(INVERSE_ON);
  });

  it("drops the inversion while the arrows are moving through the agents panel", () => {
    dispatch({ type: "view/setPanelFocused", focused: true });

    expect(inputRow(prompt)).not.toContain(INVERSE_ON);
  });

  it("drops the inversion while the shell pill is selected", () => {
    dispatch({ type: "view/setBgPillFocused", focused: true });

    expect(inputRow(prompt)).not.toContain(INVERSE_ON);
  });

  it("drops the inversion while a history search is running", () => {
    prompt.handleKey({ name: "r", sequence: "\x12", ctrl: true } as KeyEventData);

    expect(inputRow(prompt)).not.toContain(INVERSE_ON);
  });
});

describe("the caret position survives every gate", () => {
  it("reports the same position lit or unlit, so the real cursor still parks", () => {
    prompt.render(WIDTH);
    const lit = prompt.caret();

    reportWindowAttention(false);
    prompt.render(WIDTH);
    const unfocused = prompt.caret();

    reportWindowAttention(true);
    dispatch({ type: "view/setPanelFocused", focused: true });
    prompt.render(WIDTH);
    const navigating = prompt.caret();

    expect(lit).not.toBeNull();
    expect(unfocused).toEqual(lit);
    expect(navigating).toEqual(lit);
  });
});

function stripStyles(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
