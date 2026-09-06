import { describe, expect, it } from "bun:test";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.ts";
import { outputStyleCursorAfterKey } from "@/ui/panels/config/panel-keys.ts";

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

const OPTION_COUNT = 4;

describe("outputStyleCursorAfterKey", () => {
  it("moves the cursor with the arrows", () => {
    expect(outputStyleCursorAfterKey(1, OPTION_COUNT, key("down"))).toEqual({
      kind: "move",
      cursor: 2,
    });
    expect(outputStyleCursorAfterKey(1, OPTION_COUNT, key("up"))).toEqual({
      kind: "move",
      cursor: 0,
    });
  });

  it("clamps at both ends instead of wrapping", () => {
    expect(outputStyleCursorAfterKey(0, OPTION_COUNT, key("up"))).toEqual({
      kind: "move",
      cursor: 0,
    });
    expect(outputStyleCursorAfterKey(3, OPTION_COUNT, key("down"))).toEqual({
      kind: "move",
      cursor: 3,
    });
  });

  it("confirms with Enter or Space and cancels with Esc", () => {
    expect(outputStyleCursorAfterKey(2, OPTION_COUNT, key("return"))).toEqual({ kind: "commit" });
    expect(outputStyleCursorAfterKey(2, OPTION_COUNT, key("space"))).toEqual({ kind: "commit" });
    expect(outputStyleCursorAfterKey(2, OPTION_COUNT, key(undefined, { sequence: " " }))).toEqual({
      kind: "commit",
    });
    expect(outputStyleCursorAfterKey(2, OPTION_COUNT, key("escape"))).toEqual({ kind: "cancel" });
  });

  it("ignores keys the picker does not own", () => {
    expect(outputStyleCursorAfterKey(2, OPTION_COUNT, key("left"))).toBeUndefined();
    expect(
      outputStyleCursorAfterKey(2, OPTION_COUNT, key(undefined, { sequence: "x" })),
    ).toBeUndefined();
  });

  it("stays put when there is nothing to move through", () => {
    expect(outputStyleCursorAfterKey(0, 0, key("down"))).toEqual({ kind: "move", cursor: 0 });
  });
});
