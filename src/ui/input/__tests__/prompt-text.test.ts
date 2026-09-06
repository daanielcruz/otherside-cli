import { describe, expect, test } from "bun:test";
import {
  cursorDownPosition,
  cursorUpPosition,
  logicalLineEndOffset,
  logicalLineStartOffset,
  verticalStep,
} from "@/ui/input/prompt-text.ts";

describe("logical line brackets", () => {
  test("a caret on the first line starts at the buffer start", () => {
    expect(logicalLineStartOffset("one\ntwo", 1)).toBe(0);
    expect(logicalLineStartOffset("one\ntwo", 0)).toBe(0);
  });

  test("text opening with a newline still starts its first line at zero", () => {
    // The caret sits on the empty line above the break, so the break behind it
    // is its own character and must not be read as a previous line's end.
    expect(logicalLineStartOffset("\nx", 0)).toBe(0);
  });

  test("a caret past a break starts just after it", () => {
    expect(logicalLineStartOffset("one\ntwo", 4)).toBe(4);
    expect(logicalLineStartOffset("one\ntwo", 7)).toBe(4);
  });

  test("an empty buffer brackets to zero", () => {
    expect(logicalLineStartOffset("", 0)).toBe(0);
    expect(logicalLineEndOffset("", 0)).toBe(0);
  });

  test("a line ends at its break, and the last line at the buffer end", () => {
    expect(logicalLineEndOffset("one\ntwo", 1)).toBe(3);
    expect(logicalLineEndOffset("one\ntwo", 4)).toBe(7);
  });

  test("a caret on the break itself ends there rather than skipping to the next line", () => {
    expect(logicalLineEndOffset("one\ntwo", 3)).toBe(3);
  });
});

describe("verticalStep", () => {
  // Wide enough that the draft below wraps to two display rows.
  const WIDTH = 10;
  const WRAPPED = "0123456789abc";

  test("moves the caret while the draft has a row to move to", () => {
    // The offset is the row walker's own answer; what this adds is the decision
    // between moving inside the draft and leaving it.
    expect(verticalStep("up", WRAPPED, 12, WIDTH)).toEqual({
      kind: "caret",
      // Non-null because the draft wraps: there is a row above to move to.
      offset: cursorUpPosition(WRAPPED, 12, WIDTH) as number,
    });
    expect(verticalStep("down", WRAPPED, 2, WIDTH)).toEqual({
      kind: "caret",
      offset: cursorDownPosition(WRAPPED, 2, WIDTH) as number,
    });
  });

  test("steps into history when there is no row left in either direction", () => {
    expect(verticalStep("up", "abc", 1, WIDTH)).toEqual({ kind: "history" });
    expect(verticalStep("down", "abc", 1, WIDTH)).toEqual({ kind: "history" });
  });
});
