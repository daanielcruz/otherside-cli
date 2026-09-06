import { describe, expect, it } from "bun:test";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { cycleTabForKey } from "@/ui/chrome/panel-tabs.ts";

const key = (name: string | undefined, overrides: Partial<KeyEventData> = {}): KeyEventData => ({
  kind: "key",
  fn: false,
  name,
  ctrl: false,
  meta: false,
  shift: false,
  option: false,
  super: false,
  sequence: undefined,
  raw: undefined,
  isPasted: false,
  ...overrides,
});

describe("cycleTabForKey", () => {
  const focused = { tabCount: 3, headerFocused: true };

  it("cycles forward on tab and right with wrap-around", () => {
    expect(cycleTabForKey({ key: key("tab"), activeTab: 0, ...focused })).toBe(1);
    expect(cycleTabForKey({ key: key("right"), activeTab: 1, ...focused })).toBe(2);
    expect(cycleTabForKey({ key: key("tab"), activeTab: 2, ...focused })).toBe(0);
  });

  it("cycles backward on shift+tab and left with wrap-around", () => {
    expect(cycleTabForKey({ key: key("tab", { shift: true }), activeTab: 1, ...focused })).toBe(0);
    expect(cycleTabForKey({ key: key("left"), activeTab: 2, ...focused })).toBe(1);
    expect(cycleTabForKey({ key: key("tab", { shift: true }), activeTab: 0, ...focused })).toBe(2);
    expect(cycleTabForKey({ key: key("left"), activeTab: 0, ...focused })).toBe(2);
  });

  it("stays inert while the header is unfocused", () => {
    expect(
      cycleTabForKey({ key: key("tab"), activeTab: 0, tabCount: 3, headerFocused: false }),
    ).toBeUndefined();
  });

  it("ignores non-cycling and modified keys", () => {
    expect(cycleTabForKey({ key: key("down"), activeTab: 0, ...focused })).toBeUndefined();
    expect(
      cycleTabForKey({ key: key("tab", { ctrl: true }), activeTab: 0, ...focused }),
    ).toBeUndefined();
    expect(
      cycleTabForKey({ key: key("tab"), activeTab: 0, tabCount: 0, headerFocused: true }),
    ).toBeUndefined();
  });
});
