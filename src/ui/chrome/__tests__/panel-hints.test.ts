import { describe, expect, it } from "bun:test";
import {
  formatHint,
  HINT_ACTION_SPECS,
  HINT_JOINER,
  hintChord,
  hintFor,
  hintLines,
} from "@/ui/chrome/panel-hints.ts";

describe("panel hint vocabulary", () => {
  it("joins chord keys with a slash and appends the label", () => {
    expect(hintChord(["enter", "↓"])).toBe("enter/↓");
    expect(formatHint({ keys: ["enter", "↓"], label: "to select" })).toBe("enter/↓ to select");
  });

  it("phrases recurring actions from the dictionary", () => {
    expect(formatHint(hintFor("select"))).toBe("Enter/↓ to select");
    expect(formatHint(hintFor("close"))).toBe("Esc to close");
    expect(formatHint(hintFor("search"))).toBe("/ to search");
    expect(formatHint(hintFor("switch"))).toBe("←/→/tab to switch");
    expect(formatHint(hintFor("back"))).toBe("Esc to go back");
  });

  it("names each action once, so a binding change is one edit", () => {
    // Three spellings of "Esc to go back" and two each of cancel and clear used
    // to live here, which meant a binding change had to be made in every copy to
    // keep the footers agreeing.
    const seen = new Map<string, string>();
    for (const [action, hint] of Object.entries(HINT_ACTION_SPECS)) {
      const shape = `${hint.keys.join("\u0000")}|${hint.label}`;
      const first = seen.get(shape);
      expect(first, `${action} repeats ${first ?? ""}`).toBeUndefined();
      seen.set(shape, action);
    }
  });

  it("joins hints on one line when no width is given", () => {
    expect(hintLines([hintFor("close"), hintFor("search")])).toEqual([
      `Esc to close${HINT_JOINER}/ to search`,
    ]);
    expect(hintLines([])).toEqual([]);
  });

  it("wraps greedily at the width without breaking inside a hint", () => {
    const lines = hintLines([hintFor("close"), hintFor("cancel"), hintFor("select")], 20);
    expect(lines).toEqual(["Esc to close", "Esc to cancel", "Enter/↓ to select"]);
  });

  it("keeps hints together while they fit the width", () => {
    const lines = hintLines([hintFor("close"), hintFor("search")], 40);
    expect(lines).toEqual([`Esc to close${HINT_JOINER}/ to search`]);
  });

  it("gives an oversized hint a line of its own", () => {
    const lines = hintLines([{ keys: ["enter"], label: "to do something very long" }], 10);
    expect(lines).toEqual(["enter to do something very long"]);
  });
});
