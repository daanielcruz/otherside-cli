import { describe, expect, test } from "bun:test";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { chordStepForKey, chordSteps, normalizeChord } from "@/ui/keys/chord.ts";

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

describe("normalizeChord", () => {
  test("sorts modifiers and lowercases anything a modifier carries", () => {
    expect(normalizeChord("Shift+Ctrl+Tab")).toBe("ctrl+shift+tab");
    expect(normalizeChord("CTRL+A")).toBe("ctrl+a");
  });

  test("folds modifier aliases onto one spelling", () => {
    expect(normalizeChord("control+x")).toBe("ctrl+x");
    expect(normalizeChord("option+d")).toBe("alt+d");
    expect(normalizeChord("opt+d")).toBe("alt+d");
    expect(normalizeChord("command+k")).toBe("cmd+k");
    expect(normalizeChord("super+k")).toBe("cmd+k");
  });

  test("splits steps on whitespace before modifiers on plus", () => {
    expect(normalizeChord("ctrl+x ctrl+e")).toBe("ctrl+x ctrl+e");
    expect(chordSteps("ctrl+x ctrl+e")).toEqual(["ctrl+x", "ctrl+e"]);
  });

  test("collapses repeated whitespace between steps", () => {
    expect(normalizeChord("  ctrl+x   ctrl+k ")).toBe("ctrl+x ctrl+k");
  });

  test("keeps a single typed character case-sensitive", () => {
    expect(normalizeChord("g")).toBe("g");
    expect(normalizeChord("G")).toBe("G");
  });

  test("a trailing plus names the plus key itself", () => {
    expect(normalizeChord("ctrl++")).toBe("ctrl++");
  });

  test("rejects a chord with no key name", () => {
    expect(normalizeChord("")).toBeNull();
    expect(normalizeChord("   ")).toBeNull();
  });
});

describe("chordStepForKey", () => {
  test("a modified press binds by name", () => {
    expect(chordStepForKey(press({ ctrl: true, name: "x", sequence: "\x18" }))).toBe("ctrl+x");
    expect(chordStepForKey(press({ meta: true, name: "p" }))).toBe("meta+p");
    expect(chordStepForKey(press({ option: true, name: "d" }))).toBe("alt+d");
  });

  test("a named key binds by its name, not the blank it types", () => {
    expect(chordStepForKey(press({ name: "space", sequence: " " }))).toBe("space");
    expect(chordStepForKey(press({ name: "return", sequence: "\r" }))).toBe("return");
    expect(chordStepForKey(press({ name: "tab", shift: true }))).toBe("shift+tab");
  });

  test("an unmodified printable character keeps its case", () => {
    expect(chordStepForKey(press({ name: "g", sequence: "g" }))).toBe("g");
    expect(chordStepForKey(press({ name: "g", sequence: "G", shift: true }))).toBe("G");
  });

  test("a press carrying no bindable name resolves to nothing", () => {
    expect(chordStepForKey(press({}))).toBeNull();
    expect(chordStepForKey(press({ sequence: "\x1b[200~" }))).toBeNull();
  });

  test("what it produces normalizes to itself", () => {
    const step = chordStepForKey(press({ ctrl: true, shift: true, name: "tab" }));
    expect(step).not.toBeNull();
    expect(normalizeChord(step ?? "")).toBe(step);
  });
});

describe("a digit binds by the digit, not by the decoder's name for the row", () => {
  test("spells each digit as itself", () => {
    // The decoder calls every digit `number`, which says only that A digit was
    // pressed. Binding by that name would make 1 and 9 the same chord, and the
    // row jump could never tell which row was asked for.
    expect(chordStepForKey(press({ name: "number", sequence: "1" }))).toBe("1");
    expect(chordStepForKey(press({ name: "number", sequence: "9" }))).toBe("9");
  });

  test("keeps a modified digit on its decoder name", () => {
    // Under a modifier the press is a command, and the table spells commands by
    // name — `ctrl+number` is one binding by design.
    expect(chordStepForKey(press({ name: "number", sequence: "1", ctrl: true }))).toBe(
      "ctrl+number",
    );
  });

  test("leaves a named key that merely looks like one alone", () => {
    expect(chordStepForKey(press({ name: "pagedown", sequence: undefined }))).toBe("pagedown");
  });
});

describe("a space is spelled by name, never as the blank it types", () => {
  test("spells a named space and a bare one the same", () => {
    // Chords split ON spaces, so a step that IS one could never be parsed back.
    expect(chordStepForKey(press({ name: "space", sequence: " " }))).toBe("space");
    expect(chordStepForKey(press({ name: undefined, sequence: " " }))).toBe("space");
  });

  test("what it produces still normalizes to itself", () => {
    const step = chordStepForKey(press({ name: undefined, sequence: " " }));
    expect(normalizeChord(step as string)).toBe("space");
  });
});

describe("a meta chord sent as ESC and a letter", () => {
  test("spells as meta plus the letter, however the decoder reports it", () => {
    // Many terminals send Meta+d as ESC d and set no name — some also leave the
    // meta flag off, and some report the name as an empty string. The sequence is
    // the only part that always says what was pressed.
    expect(chordStepForKey(press({ name: undefined, sequence: "\x1bd" }))).toBe("meta+d");
    expect(chordStepForKey(press({ name: "", sequence: "\x1bd", meta: true }))).toBe("meta+d");
    expect(chordStepForKey(press({ name: "", sequence: "\x1by" }))).toBe("meta+y");
  });

  test("leaves an escape-led sequence that is not a letter alone", () => {
    expect(chordStepForKey(press({ name: undefined, sequence: "\x1b[D" }))).toBeNull();
  });
});
