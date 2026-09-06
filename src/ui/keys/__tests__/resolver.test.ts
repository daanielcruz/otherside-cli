import { afterEach, describe, expect, test } from "bun:test";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { CTRL_X_CHORD_WINDOW_MS } from "@/ui/input/ctrl-x-chord.ts";
import { pendingChordPrefix, releasePendingChord, resolveKey } from "@/ui/keys/resolver.ts";

function press(over: Partial<KeyEventData>): KeyEventData {
  return {
    kind: "key",
    fn: false,
    name: undefined,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: undefined,
    raw: undefined,
    isPasted: false,
    ...over,
  };
}

const CTRL_X = press({ ctrl: true, name: "x" });
const CTRL_E = press({ ctrl: true, name: "e" });

afterEach(() => {
  releasePendingChord();
});

describe("resolveKey", () => {
  test("answers the action the context binds", () => {
    expect(resolveKey({ key: press({ name: "down" }), contexts: ["select"], now: 0 })).toEqual({
      kind: "action",
      action: "select:next",
      context: "select",
    });
  });

  test("the innermost context wins a chord both bind", () => {
    // `escape` closes a panel and interrupts a turn; whichever is inner answers.
    const inner = resolveKey({
      key: press({ name: "escape" }),
      contexts: ["panel", "app"],
      now: 0,
    });
    expect(inner).toEqual({ kind: "action", action: "panel:close", context: "panel" });

    const outer = resolveKey({ key: press({ name: "escape" }), contexts: ["app"], now: 0 });
    expect(outer).toEqual({ kind: "action", action: "app:interrupt", context: "app" });
  });

  test("a context absent from the stack never answers", () => {
    expect(resolveKey({ key: press({ name: "down" }), contexts: ["app"], now: 0 })).toEqual({
      kind: "none",
    });
  });

  test("an unbound press is nobody's business", () => {
    const key = press({ name: "f7" });
    expect(resolveKey({ key, contexts: ["select", "panel", "app"], now: 0 })).toEqual({
      kind: "none",
    });
  });
});

describe("chords", () => {
  test("a prefix parks, and the next step completes it", () => {
    expect(resolveKey({ key: CTRL_X, contexts: ["prompt"], now: 0 })).toEqual({
      kind: "pending",
      prefix: "ctrl+x",
    });
    expect(pendingChordPrefix(0)).toBe("ctrl+x");

    expect(resolveKey({ key: CTRL_E, contexts: ["prompt"], now: 10 })).toEqual({
      kind: "action",
      action: "prompt:externalEditor",
      context: "prompt",
    });
    expect(pendingChordPrefix(10)).toBeNull();
  });

  test("the prefix expires with the session's one chord window", () => {
    resolveKey({ key: CTRL_X, contexts: ["prompt"], now: 0 });
    expect(pendingChordPrefix(CTRL_X_CHORD_WINDOW_MS)).toBe("ctrl+x");
    expect(pendingChordPrefix(CTRL_X_CHORD_WINDOW_MS + 1)).toBeNull();
  });

  test("a key that finishes nothing spends the prefix and still acts on its own", () => {
    resolveKey({ key: CTRL_X, contexts: ["prompt", "app"], now: 0 });
    expect(
      resolveKey({ key: press({ ctrl: true, name: "t" }), contexts: ["prompt", "app"], now: 5 }),
    ).toEqual({
      kind: "action",
      action: "app:toggleTaskList",
      context: "app",
    });
    expect(pendingChordPrefix(5)).toBeNull();
  });

  test("the continuation key alone is not the chord", () => {
    // Ctrl+E without the prefix is the line-end motion, never the editor.
    expect(resolveKey({ key: CTRL_E, contexts: ["edit", "prompt"], now: 0 })).toEqual({
      kind: "action",
      action: "edit:moveLineEnd",
      context: "edit",
    });
  });

  test("a press with no bindable name releases a parked prefix", () => {
    resolveKey({ key: CTRL_X, contexts: ["prompt"], now: 0 });
    expect(resolveKey({ key: press({}), contexts: ["prompt"], now: 5 })).toEqual({ kind: "none" });
    expect(pendingChordPrefix(5)).toBeNull();
  });

  test("only a context that holds the prefix parks it", () => {
    expect(resolveKey({ key: CTRL_X, contexts: ["select"], now: 0 })).toEqual({ kind: "none" });
    expect(pendingChordPrefix(0)).toBeNull();
  });
});

describe("row jumps", () => {
  test("a digit takes that row wherever a list is listed", () => {
    expect(
      resolveKey({ key: press({ name: "3", sequence: "3" }), contexts: ["select"], now: 0 }),
    ).toEqual({ kind: "action", action: "select:jumpToRow", context: "select", row: 3 });
  });

  test("zero is not a row", () => {
    expect(
      resolveKey({ key: press({ name: "0", sequence: "0" }), contexts: ["select"], now: 0 }),
    ).toEqual({ kind: "none" });
  });

  test("a digit outside a list context stays unclaimed", () => {
    expect(
      resolveKey({ key: press({ name: "3", sequence: "3" }), contexts: ["app"], now: 0 }),
    ).toEqual({
      kind: "none",
    });
  });
});
