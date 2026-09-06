import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import chalk from "chalk";
import { promptStore, setPromptMenuOpen, setPromptText } from "@/store/prompt/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { StringFocusStack } from "@/terminal-runtime/string-view/focus.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { StringViewChromeRegion } from "@/ui/chrome/string-view-chrome-region.ts";
import { StringViewAutocomplete } from "@/ui/input/string-view-autocomplete.ts";
import { StringViewPrompt } from "@/ui/input/string-view-prompt.ts";

const originalColorLevel = chalk.level;
const HIGHLIGHT_SGR = "\x1b[38;2;177;185;249m";
let prompt: StringViewPrompt;
let autocomplete: StringViewAutocomplete;
let focus: StringFocusStack;
let renderRequests: number;
let submitted: string[];

beforeAll(() => {
  chalk.level = 3;
});

beforeEach(() => {
  setPromptText("");
  setPromptMenuOpen(false);
  focus = new StringFocusStack();
  renderRequests = 0;
  submitted = [];
  const context: StringViewContext = {
    requestRender: () => renderRequests++,
    pushFocus: (target) => focus.push(target),
    popFocus: (target) => focus.pop(target),
  };
  prompt = new StringViewPrompt((text) => submitted.push(text));
  autocomplete = new StringViewAutocomplete(prompt);
  prompt.mount(context);
  autocomplete.mount(context);
});

afterEach(() => {
  autocomplete.unmount();
  prompt.unmount();
  setPromptText("");
  setPromptMenuOpen(false);
});

afterAll(() => {
  chalk.level = originalColorLevel;
});

describe("StringViewAutocomplete", () => {
  it("filters slash commands and highlights the selected row", () => {
    setPromptText("/c");
    const rows = autocomplete.render(80);
    const plain = rows.map(stripAnsi);

    expect(promptStore.getState().menuOpen).toBe(true);
    expect(focus.current()).toBe(autocomplete);
    expect(rows).toHaveLength(6);
    // The menu owns the footer: the status and mode rows go, and only the bottom
    // margin stays, because that belongs to the frame's last row rather than to
    // whatever happens to be sitting on it.
    expect(new StringViewChromeRegion().render(80)).toEqual(["", ""]);
    expect(plain[0]?.trimStart()).toStartWith("/cd");
    expect(plain[1]?.trimStart()).toStartWith("/clear");
    expect(rows[0]).toContain(HIGHLIGHT_SGR);
    expect(rows[0]).not.toContain("\x1b[1m");
  });

  it("lights the whole selected row and the matched slice of the others", () => {
    setPromptText("/co");
    const rows = autocomplete.render(80);

    // Selected row: one highlighted line, no bold, description included.
    const selected = rows[0] ?? "";
    expect(stripAnsi(selected)).toContain("/co");
    expect(selected).toContain(HIGHLIGHT_SGR);
    expect(selected).not.toContain("\x1b[1m");

    // Unselected rows: muted base with the first "co" occurrence lit.
    const unselected = rows.find(
      (row, index) => index > 0 && row.length > 0 && stripAnsi(row).toLowerCase().includes("co"),
    );
    expect(unselected).toBeDefined();
    const litSlices = (unselected ?? "").split(HIGHLIGHT_SGR).slice(1);
    expect(litSlices.length).toBeGreaterThanOrEqual(1);
    for (const slice of litSlices) {
      expect(stripAnsi(`${HIGHLIGHT_SGR}${slice}`).toLowerCase()).toStartWith("co");
    }
  });

  it("lights a fully typed valid command in the prompt and leaves arguments plain", () => {
    setPromptText("/config");
    const validRow = prompt.render(80).join("\n");
    expect(validRow).toContain(`${HIGHLIGHT_SGR}/config`);

    setPromptText("/config abc");
    const argsRow = prompt.render(80).join("\n");
    expect(argsRow).toContain(`${HIGHLIGHT_SGR}/config`);
    expect(argsRow).not.toContain(`${HIGHLIGHT_SGR}/config abc`);

    setPromptText("/xyzq");
    expect(prompt.render(80).join("\n")).not.toContain(HIGHLIGHT_SGR);
  });

  it("keeps the prompt caret lit while the menu holds focus", () => {
    const caretContext: StringViewContext = {
      requestRender: () => renderRequests++,
      pushFocus: (target) => focus.push(target),
      popFocus: (target) => focus.pop(target),
      currentFocus: () => focus.current(),
    };
    prompt.unmount();
    autocomplete.unmount();
    prompt = new StringViewPrompt((text) => submitted.push(text));
    autocomplete = new StringViewAutocomplete(prompt);
    prompt.mount(caretContext);
    autocomplete.mount(caretContext);

    setPromptText("/co");
    expect(focus.current()).toBe(autocomplete);
    const promptRows = prompt.render(80);
    expect(promptRows.join("\n")).toContain("\x1b[7m");
  });

  it("owns arrow and enter keys, then submits the selection on a single enter", () => {
    setPromptText("/c");
    const promptBefore = prompt.getText();

    expect(focus.route(key("down", "\u001b[B"))).toBe(true);
    expect(prompt.getText()).toBe(promptBefore);
    const rows = autocomplete.render(80);
    expect(rows[1]?.startsWith(HIGHLIGHT_SGR)).toBe(true);
    expect(rows[0]?.startsWith(HIGHLIGHT_SGR)).toBe(false);

    focus.route(key("return", "\r"));
    // A single Enter accepts the highlighted command and submits it in one step,
    // so the prompt clears and the menu closes without a second keystroke.
    expect(submitted).toEqual(["/clear"]);
    expect(prompt.getText()).toBe("");
    expect(promptStore.getState().menuOpen).toBe(false);
    expect(autocomplete.render(80)).toEqual([]);
    expect(focus.current()).toBe(prompt);
  });

  it("hands arrows to history when the menu holds a single option", () => {
    setPromptText("recalled entry");
    focus.route(key("return", "\r"));
    setPromptText("/compact");
    const rows = autocomplete.render(80).filter((row) => row.length > 0);
    expect(rows).toHaveLength(1);

    focus.route(key("up", "\u001b[A"));

    expect(prompt.getText()).toBe("recalled entry");
    expect(stripAnsi(prompt.render(80)[0] ?? "")).toMatch(/History 1\/\d+/);
  });

  it("keeps arrows on the menu while more than one option can be selected", () => {
    setPromptText("older entry");
    focus.route(key("return", "\r"));
    setPromptText("/c");
    const promptBefore = prompt.getText();

    focus.route(key("down", "\u001b[B"));

    expect(prompt.getText()).toBe(promptBefore);
    expect(autocomplete.render(80)[1]?.startsWith(HIGHLIGHT_SGR)).toBe(true);
  });

  it("Tab completes without submitting", () => {
    setPromptText("/c");
    focus.route(key("tab", "\t"));

    expect(prompt.getText()).toBe("/cd");
    expect(submitted).toEqual([]);
    expect(promptStore.getState().menuOpen).toBe(false);
    expect(focus.current()).toBe(prompt);
  });

  it("stays closed after a completed command token so the prompt owns argument hints", () => {
    setPromptText("/cd ");

    expect(autocomplete.render(80)).toEqual([]);
    expect(promptStore.getState().menuOpen).toBe(false);
    expect(focus.current()).toBe(prompt);
  });

  it("escape closes the menu and the next printable key reaches the prompt", () => {
    setPromptText("/c");
    focus.route(key("escape", "\u001b"));
    expect(focus.current()).toBe(prompt);
    expect(promptStore.getState().menuOpen).toBe(false);

    focus.route(key(undefined, "x"));
    expect(prompt.getText()).toBe("/cx");
    expect(renderRequests).toBeGreaterThan(0);
  });
});

function key(name: string | undefined, sequence: string): KeyEventData {
  return {
    kind: "key",
    fn: false,
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence,
    raw: sequence,
    isPasted: false,
  };
}
