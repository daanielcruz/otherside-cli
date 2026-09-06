import { describe, expect, test } from "bun:test";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { panelKey, panelLeaves } from "@/ui/chrome/panel-keys.ts";
import { configStepDirection } from "@/ui/panels/config/panel-keys.ts";

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

describe("what a panel key means", () => {
  test("names the four a panel answers to", () => {
    expect(panelKey(press({ name: "return" }))).toBe("confirm");
    expect(panelKey(press({ name: "escape" }))).toBe("close");
    expect(panelKey(press({ name: "left" }))).toBe("back");
    expect(panelKey(press({ name: "space", sequence: " " }))).toBe("toggle");
  });

  test("declines what the panel context does not claim", () => {
    // The list keys are the list's, and a typed character is the search box's.
    expect(panelKey(press({ name: "down" }))).toBeUndefined();
    expect(panelKey(press({ name: "j", sequence: "j" }))).toBeUndefined();
    expect(panelKey(press({ name: "q", sequence: "q" }))).toBeUndefined();
  });

  test("declines a modified key, which carries a gesture rather than a panel action", () => {
    expect(panelKey(press({ name: "return", ctrl: true }))).toBeUndefined();
  });
});

describe("levels and the contexts that claim their keys first", () => {
  test("names both halves of moving between levels", () => {
    expect(panelKey(press({ name: "left" }))).toBe("back");
    expect(panelKey(press({ name: "right" }))).toBe("forward");
  });

  test("a config row steps its value, so config claims the arrows first", () => {
    // A config row cycles rather than opening a level; an inner context claiming
    // the key before an outer one is exactly what the stack is for.
    expect(configStepDirection(press({ name: "left" }))).toBe(-1);
    expect(configStepDirection(press({ name: "right" }))).toBe(1);
    expect(configStepDirection(press({ name: "return" }))).toBeNull();
  });
});

describe("leaving where you are", () => {
  test("is either key, so a surface with no back level answers to both", () => {
    expect(panelLeaves(press({ name: "escape" }))).toBe(true);
    expect(panelLeaves(press({ name: "left" }))).toBe(true);
  });

  test("is not what taking a row or going in means", () => {
    expect(panelLeaves(press({ name: "return" }))).toBe(false);
    expect(panelLeaves(press({ name: "right" }))).toBe(false);
    expect(panelLeaves(press({ name: "j", sequence: "j" }))).toBe(false);
  });
});
