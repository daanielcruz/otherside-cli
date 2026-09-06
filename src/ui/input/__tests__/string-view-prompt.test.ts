import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setActivePasteStore } from "@/kernel/std/paste/registry.ts";
import { overlayStore } from "@/store/overlay-stack/index.ts";
import { createPasteStore } from "@/store/paste-store/index.ts";
import {
  promptStore,
  setPromptBashMode,
  setPromptPasteExpandHint,
  setPromptSearch,
  setPromptText,
} from "@/store/prompt/index.ts";
import { queueStore } from "@/store/queue-store/index.ts";
import { runningRef } from "@/store/turn-run/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.ts";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.ts";
import { armCtrlXChord, releaseCtrlXChord } from "@/ui/input/ctrl-x-chord.ts";
import { resetKillRing } from "@/ui/input/kill-ring.ts";
import { StringViewPrompt } from "@/ui/input/string-view-prompt.ts";

let prompt: StringViewPrompt;
let submitted: string[];
let terminalRows: number;

beforeEach(() => {
  setPromptText("");
  setPromptBashMode(false);
  setPromptSearch(null);
  queueStore.setState(() => ({ messages: [] }));
  overlayStore.setState(() => ({ openStack: [], pendingChain: [], slices: {} }));
  runningRef.current = false;
  resetKillRing();
  setActivePasteStore(createPasteStore("prompt-input-test"));
  submitted = [];
  terminalRows = 24;
  const context: StringViewContext = {
    requestRender() {},
    pushFocus() {},
    popFocus() {},
    terminalRows: () => terminalRows,
  };
  prompt = new StringViewPrompt((text) => submitted.push(text));
  prompt.mount(context);
});

afterEach(() => {
  prompt.unmount();
  releaseCtrlXChord();
  setActivePasteStore(null);
  setPromptText("");
  setPromptBashMode(false);
  setPromptSearch(null);
  queueStore.setState(() => ({ messages: [] }));
  overlayStore.setState(() => ({ openStack: [], pendingChain: [], slices: {} }));
  runningRef.current = false;
  resetKillRing();
});

describe("StringViewPrompt visibility", () => {
  it("keeps the prompt rows while a session picker overlay is open", () => {
    overlayStore.setState((state) => ({
      ...state,
      openStack: [{ name: "resume" }],
    }));

    // Panels are compact: the promptbar always renders beneath them.
    expect(prompt.render(72)).toHaveLength(3);
  });
});

describe("StringViewPrompt navigation", () => {
  it("moves Home and End within the current visual row", () => {
    setPromptText("abcdefghij");
    prompt.render(10);

    press("home", "\x1b[H");
    press(undefined, "X");
    expect(prompt.getText()).toBe("abcdefXghij");

    press("end", "\x1b[F");
    press(undefined, "Y");
    expect(prompt.getText()).toBe("abcdefXghijY");
  });

  it("moves Ctrl+A and Ctrl+E within the current logical line", () => {
    setPromptText("abc\ndef");
    press("a", "\x01", { ctrl: true });
    press(undefined, "X");
    press("e", "\x05", { ctrl: true });
    press(undefined, "Y");

    expect(prompt.getText()).toBe("abc\nXdefY");
  });

  it("supports Ctrl+B/F over Unicode graphemes and Meta+B/F over words", () => {
    setPromptText("a😀");
    press("b", "\x02", { ctrl: true });
    press(undefined, "X");
    press("f", "\x06", { ctrl: true });
    press(undefined, "Y");
    expect(prompt.getText()).toBe("aX😀Y");

    setPromptText("alpha beta");
    press("left", "\x1bb", { meta: true });
    press(undefined, "X");
    press("right", "\x1bf", { meta: true });
    press(undefined, "Y");
    expect(prompt.getText()).toBe("alpha XbetaY");
  });

  it("restores queued messages before navigating history from an empty prompt", () => {
    let restores = 0;
    const queuedPrompt = new StringViewPrompt(
      undefined,
      undefined,
      () => {
        restores++;
        return "queued message";
      },
      { allowed: false, markShown() {} },
    );

    queuedPrompt.handleKey(keyEvent("up", "\x1b[A"));

    expect(queuedPrompt.getText()).toBe("queued message");
    expect(restores).toBe(1);
  });

  it("shows the queued-edit hint once per prompt session while a turn is active", () => {
    queueStore.setState(() => ({
      messages: [{ id: "q1", text: "queued", expanded: "queued" }],
    }));
    runningRef.current = true;
    let shown = 0;
    const queuedPrompt = new StringViewPrompt(undefined, undefined, undefined, {
      allowed: true,
      markShown: () => shown++,
    });

    const first = queuedPrompt.render(80).map(stripAnsi);
    queuedPrompt.render(80);

    expect(first[1]).toContain("Press up to edit queued messages");
    expect(shown).toBe(1);
  });
});

describe("StringViewPrompt editing bindings", () => {
  it("deletes a whole grapheme with Ctrl+H", () => {
    setPromptText("a👨‍👩‍👧‍👦");
    press("h", "\x08", { ctrl: true });
    expect(prompt.getText()).toBe("a");
  });

  it("deletes forward with Ctrl+D and deletes a word with Meta+D", () => {
    setPromptText("😀 one two");
    press("a", "\x01", { ctrl: true });
    press("d", "\x04", { ctrl: true });
    expect(prompt.getText()).toBe(" one two");

    press("", "\x1bd", { meta: true });
    expect(prompt.getText()).toBe("one two");
    press("", "\x1bd", { meta: true });
    expect(prompt.getText()).toBe("two");
  });

  it("kills with Ctrl+W/U/K and yanks with Ctrl+Y", () => {
    setPromptText("alpha beta\ngamma");
    press("w", "\x17", { ctrl: true });
    expect(prompt.getText()).toBe("alpha beta\n");
    press("u", "\x15", { ctrl: true });
    expect(prompt.getText()).toBe("alpha beta");
    press("a", "\x01", { ctrl: true });
    press("k", "\x0b", { ctrl: true });
    expect(prompt.getText()).toBe("");
    press("y", "\x19", { ctrl: true });
    expect(prompt.getText()).toBe("alpha beta");
  });

  it("cycles older kills with Meta+Y immediately after yank", () => {
    setPromptText("old");
    press("u", "\x15", { ctrl: true });
    press("left", "\x1b[D");
    setPromptText("new");
    press("u", "\x15", { ctrl: true });
    press("y", "\x19", { ctrl: true });
    expect(prompt.getText()).toBe("new");
    press("", "\x1by", { meta: true });
    expect(prompt.getText()).toBe("old");
  });

  it("uses Meta+Delete to kill only to the visual line end", () => {
    setPromptText("abcdefghij");
    prompt.render(10);
    press("home", "\x1b[H");
    press("delete", "\x1b[3;3~", { meta: true });
    expect(prompt.getText()).toBe("abcdef");
  });

  it("deletes image and pasted-text references atomically", () => {
    setPromptText("x[Image #1]");
    press("h", "\x08", { ctrl: true });
    expect(prompt.getText()).toBe("x");

    setPromptText("[Pasted text #2 +3 lines]x");
    press("a", "\x01", { ctrl: true });
    press("d", "\x04", { ctrl: true });
    expect(prompt.getText()).toBe("x");
  });
});

describe("StringViewPrompt undo", () => {
  it("rewinds a typing burst as one step with Ctrl+_", () => {
    typeText("hello world");
    expect(prompt.getText()).toBe("hello world");

    press("_", "\x1f", { ctrl: true });
    expect(prompt.getText()).toBe("");
  });

  it("restores the caret alongside the text", () => {
    setPromptText("hello");
    press("u", "\x15", { ctrl: true });
    expect(prompt.getText()).toBe("");

    press("_", "\x1f", { ctrl: true });
    expect(prompt.getText()).toBe("hello");
    typeText("!");
    expect(prompt.getText()).toBe("hello!");
  });

  it("does nothing once the history is spent, and never redoes", () => {
    typeText("abc");
    press("_", "\x1f", { ctrl: true });
    press("_", "\x1f", { ctrl: true });
    expect(prompt.getText()).toBe("");
  });

  it("drops the history of a submitted prompt", () => {
    typeText("sent");
    press("return", "\r");
    expect(submitted).toEqual(["sent"]);

    press("_", "\x1f", { ctrl: true });
    expect(prompt.getText()).toBe("");
  });
});

describe("StringViewPrompt stash", () => {
  it("parks the draft on Ctrl+S and hands it back on the next Ctrl+S", () => {
    typeText("half a thought");

    press("s", "\x13", { ctrl: true });
    expect(prompt.getText()).toBe("");
    expect(promptStore.getState().notice).toContain("stashed");

    press("s", "\x13", { ctrl: true });
    expect(prompt.getText()).toBe("half a thought");
    expect(promptStore.getState().notice).toBe("prompt restored");
  });

  it("keeps a new draft typed over the stash and restores only into an empty prompt", () => {
    typeText("parked");
    press("s", "\x13", { ctrl: true });
    typeText("new draft");

    // A prompt with text stashes instead of restoring: the slot takes the new draft.
    press("s", "\x13", { ctrl: true });
    press("s", "\x13", { ctrl: true });
    expect(prompt.getText()).toBe("new draft");
  });

  it("says nothing on Ctrl+S with an empty prompt and an empty slot", () => {
    press("s", "\x13", { ctrl: true });

    expect(prompt.getText()).toBe("");
    expect(promptStore.getState().notice).toBeNull();
  });
});

describe("StringViewPrompt escape ladder", () => {
  it("arms on the first Escape and clears on the second", () => {
    typeText("draft worth keeping");

    press("escape", "\x1b");
    expect(prompt.getText()).toBe("draft worth keeping");
    expect(promptStore.getState().notice).toBe("Press Esc again to clear");

    press("escape", "\x1b");
    expect(prompt.getText()).toBe("");
    expect(promptStore.getState().notice).toBeNull();
  });

  it("disarms as soon as anything else is typed", () => {
    typeText("draft");
    press("escape", "\x1b");

    typeText("!");
    expect(promptStore.getState().notice).toBeNull();

    press("escape", "\x1b");
    expect(prompt.getText()).toBe("draft!");
    expect(promptStore.getState().notice).toBe("Press Esc again to clear");
  });

  it("never arms on an empty prompt — there is nothing to clear", () => {
    press("escape", "\x1b");
    press("escape", "\x1b");

    expect(prompt.getText()).toBe("");
    expect(promptStore.getState().notice).toBeNull();
  });
});

describe("StringViewPrompt panel keys", () => {
  it("types ? into the buffer wherever it lands", () => {
    press(undefined, "?");
    expect(prompt.getText()).toBe("?");
    expect(overlayStore.getState().openStack).toHaveLength(0);

    typeText("what?");
    expect(prompt.getText()).toBe("?what?");
    expect(overlayStore.getState().openStack).toHaveLength(0);
  });

  it("opens the model picker on meta+p", () => {
    typeText("keep me");

    press("", "\x1bp", { meta: true });

    expect(prompt.getText()).toBe("keep me");
    expect(overlayStore.getState().openStack.map((entry) => entry.name)).toEqual(["model"]);
  });
});

describe("StringViewPrompt external editor", () => {
  function promptWithEditor(edit: (text: string) => string | null): {
    view: StringViewPrompt;
    seen: string[];
  } {
    const seen: string[] = [];
    const view = new StringViewPrompt(undefined, undefined, undefined, undefined, null, (text) => {
      seen.push(text);
      return edit(text);
    });
    view.mount({ requestRender() {}, pushFocus() {}, popFocus() {} });
    return { view, seen };
  }

  it("replaces the buffer with what Ctrl+G saved", () => {
    const { view, seen } = promptWithEditor((text) => `${text} — rewritten`);
    setPromptText("draft");

    view.handleKey(keyEvent("g", "\x07", { ctrl: true }));

    expect(seen).toEqual(["draft"]);
    expect(view.getText()).toBe("draft — rewritten");
    view.unmount();
    setPromptText("");
  });

  it("opens on Ctrl+E only after the Ctrl+X prefix, and keeps the draft on abort", () => {
    const { view, seen } = promptWithEditor(() => null);
    setPromptText("alpha beta");
    view.handleKey(keyEvent("a", "\x01", { ctrl: true }));

    // Ctrl+E alone stays end-of-line.
    view.handleKey(keyEvent("e", "\x05", { ctrl: true }));
    view.handleKey(keyEvent(undefined, "!"));
    expect(seen).toEqual([]);
    expect(view.getText()).toBe("alpha beta!");

    armCtrlXChord();
    view.handleKey(keyEvent("e", "\x05", { ctrl: true }));
    expect(seen).toEqual(["alpha beta!"]);
    expect(view.getText()).toBe("alpha beta!");
    view.unmount();
    setPromptText("");
  });
});

describe("StringViewPrompt process chords", () => {
  it("hands Ctrl+D to the host only when the prompt is empty", () => {
    expect(prompt.handleKey(keyEvent("d", "\x04", { ctrl: true }))).toBe(false);

    setPromptText("abc");
    press("a", "\x01", { ctrl: true });
    expect(prompt.handleKey(keyEvent("d", "\x04", { ctrl: true }))).not.toBe(false);
    expect(prompt.getText()).toBe("bc");
  });

  it("never owns Ctrl+Z, empty or not", () => {
    expect(prompt.handleKey(keyEvent("z", "\x1a", { ctrl: true }))).toBe(false);

    setPromptText("draft");
    expect(prompt.handleKey(keyEvent("z", "\x1a", { ctrl: true }))).toBe(false);
    expect(prompt.getText()).toBe("draft");
  });
});

describe("StringViewPrompt history and multiline input", () => {
  it("navigates history with Ctrl+P and Ctrl+N", () => {
    typeText("first");
    press("return", "\r");
    typeText("second");
    press("return", "\r");

    press("p", "\x10", { ctrl: true });
    expect(prompt.getText()).toBe("second");
    expect(stripAnsi(prompt.render(80)[0] ?? "")).toMatch(/History 1\/\d+/);
    press("p", "\x10", { ctrl: true });
    expect(prompt.getText()).toBe("first");
    press("n", "\x0e", { ctrl: true });
    expect(prompt.getText()).toBe("second");
    press("n", "\x0e", { ctrl: true });
    expect(prompt.getText()).toBe("");
  });

  it("runs reverse history search with status, repeat, and cancel", () => {
    typeText("deploy old");
    press("return", "\r");
    typeText("deploy new");
    press("return", "\r");
    typeText("draft");

    press("r", "\x12", { ctrl: true });
    typeText("deploy");
    expect(prompt.getText()).toBe("deploy new");
    expect(promptStore.getState().search).toEqual({
      query: "deploy",
      failed: false,
      scope: "everywhere",
    });
    press("r", "\x12", { ctrl: true });
    expect(prompt.getText()).toBe("deploy old");
    press("c", "\x03", { ctrl: true });
    expect(prompt.getText()).toBe("draft");
    expect(promptStore.getState().search).toBeNull();
  });

  it("accepts decoder multiline aliases and trailing backslash continuation", () => {
    typeText("a\\");
    press("return", "\r");
    press("return", "\x1bOM");
    press("return", "\x1b\r", { meta: true });
    press("enter", "\n");
    expect(prompt.getText()).toBe("a\n\n\n\n");
    expect(submitted).toEqual([]);
  });

  it("fully normalizes pasted text", () => {
    press("", "e\u0301\t\x1b[31mred\x1b[0m\r\nnext", { isPasted: true });
    expect(prompt.getText()).toBe("é    red\nnext");
  });

  it("expands a matching collapsed paste on the next paste, even after its hint clears", () => {
    const pasted = "alpha\nbeta\ngamma\ndelta";

    press("", pasted, { isPasted: true });
    expect(prompt.getText()).toBe("[Pasted text #1 +3 lines]");
    expect(promptStore.getState().pasteExpandHint).toBe(true);

    setPromptPasteExpandHint(false);
    press("", pasted, { isPasted: true });
    expect(prompt.getText()).toBe(pasted);
    expect(promptStore.getState().pasteExpandHint).toBe(false);

    press("return", "\r");
    expect(submitted).toEqual([pasted]);
  });

  it("keeps different collapsed pastes as adjacent references", () => {
    press("", "alpha\nbeta\ngamma\ndelta", { isPasted: true });
    press("", "one\ntwo\nthree\nfour", { isPasted: true });

    expect(prompt.getText()).toBe("[Pasted text #1 +3 lines][Pasted text #2 +3 lines]");
  });

  it("uses the smaller inline-paste allowance in a short terminal", () => {
    terminalRows = 11;

    press("", "alpha\nbeta\ngamma", { isPasted: true });

    expect(prompt.getText()).toBe("[Pasted text #1 +2 lines]");
  });

  it("renders the shell-mode glyph instead of the prompt chevron", () => {
    press(undefined, "!");
    const content = stripAnsi(prompt.render(40)[1] ?? "");
    expect(content.startsWith("!\u00A0")).toBe(true);
    expect(promptStore.getState().bashMode).toBe(true);
  });
});

describe("StringViewPrompt slash argument hints", () => {
  it("places the argument hint on the input row inside the promptbar frame", () => {
    typeText("/fork ");
    const rows = prompt.render(80).map(stripAnsi);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain("<directive>");
    // Hint must sit on the framed input row, not below the bottom rule.
    expect(rows[2]).not.toContain("<directive>");
  });

  it("hides the argument hint once an argument is typed", () => {
    typeText("/fork something");
    const rows = prompt.render(80).map(stripAnsi);
    expect(rows[1]).not.toContain("<directive>");
  });
});

describe("StringViewPrompt Apple_Terminal Shift+Return", () => {
  function promptWithReader(reader: (() => boolean) | null): {
    view: StringViewPrompt;
    sent: string[];
  } {
    const sent: string[] = [];
    const view = new StringViewPrompt(
      (text) => sent.push(text),
      undefined,
      undefined,
      undefined,
      reader,
    );
    view.mount({ requestRender() {}, pushFocus() {}, popFocus() {} });
    return { view, sent };
  }

  it("inserts a newline when the probe reports Shift held", () => {
    const { view, sent } = promptWithReader(() => true);
    for (const character of "abc") view.handleKey(keyEvent(undefined, character));
    view.handleKey(keyEvent("return", "\r"));
    view.handleKey(keyEvent(undefined, "d"));
    view.handleKey(keyEvent("return", "\r", { shift: true }));
    expect(sent).toEqual([]);
    view.unmount();
    setPromptText("");
  });

  it("submits when the probe reports Shift up, and with no probe at all", () => {
    const { view, sent } = promptWithReader(() => false);
    for (const character of "ok") view.handleKey(keyEvent(undefined, character));
    view.handleKey(keyEvent("return", "\r"));
    expect(sent).toEqual(["ok"]);
    view.unmount();

    const bare = promptWithReader(null);
    for (const character of "go") bare.view.handleKey(keyEvent(undefined, character));
    bare.view.handleKey(keyEvent("return", "\r"));
    expect(bare.sent).toEqual(["go"]);
    bare.view.unmount();
    setPromptText("");
  });
});

function typeText(text: string): void {
  for (const character of text) press(undefined, character);
}

function press(
  name: string | undefined,
  sequence: string,
  flags: Partial<Pick<KeyEventData, "ctrl" | "meta" | "shift" | "option" | "isPasted">> = {},
): void {
  prompt.handleKey(keyEvent(name, sequence, flags));
}

function keyEvent(
  name: string | undefined,
  sequence: string,
  flags: Partial<Pick<KeyEventData, "ctrl" | "meta" | "shift" | "option" | "isPasted">> = {},
): KeyEventData {
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
    ...flags,
  };
}

describe("StringViewPrompt kill notice", () => {
  it("says how to get killed text back after every kill key", () => {
    setPromptText("alpha beta");
    press("u", "\x15", { ctrl: true });
    expect(promptStore.getState().notice).toBe("Ctrl+Y to paste deleted text");

    setPromptText("");
    press("y", "\x19", { ctrl: true });
    expect(prompt.getText()).toBe("alpha beta");

    press("a", "\x01", { ctrl: true });
    press("k", "\x0b", { ctrl: true });
    expect(promptStore.getState().notice).toBe("Ctrl+Y to paste deleted text");
  });

  it("says nothing when the kill key had nothing to take", () => {
    setPromptText("");
    press("u", "\x15", { ctrl: true });
    expect(promptStore.getState().notice).toBeNull();
  });

  it("puts the transient row away on backspace or delete", () => {
    setPromptText("alpha beta");
    press("u", "\x15", { ctrl: true });
    expect(promptStore.getState().notice).toBe("Ctrl+Y to paste deleted text");

    setPromptText("word");
    press("backspace", "\x7f");
    expect(promptStore.getState().notice).toBeNull();
    // The key keeps its editing job while it takes the row away.
    expect(prompt.getText()).toBe("wor");

    press("u", "\x15", { ctrl: true });
    expect(promptStore.getState().notice).toBe("Ctrl+Y to paste deleted text");
    press("delete", "\x1b[3~");
    expect(promptStore.getState().notice).toBeNull();
  });

  it("puts the paste-expand hint away on the same keys", () => {
    press("", "alpha\nbeta\ngamma\ndelta", { isPasted: true });
    expect(promptStore.getState().pasteExpandHint).toBe(true);

    press("backspace", "\x7f");
    expect(promptStore.getState().pasteExpandHint).toBe(false);
  });
});
