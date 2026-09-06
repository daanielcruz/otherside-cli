import { describe, expect, test } from "bun:test";
import { openBoundaryScanner } from "@/terminal-runtime/terminal/stream-boundaries.ts";

const sequence = (value: string) => ({ type: "sequence" as const, value });
const text = (value: string) => ({ type: "text" as const, value });

describe("terminal sequence boundaries", () => {
  test("retains incomplete sequences across chunks and exposes pending bytes", () => {
    const boundaries = openBoundaryScanner();
    expect(boundaries.accept("one\x1b[")).toEqual([text("one")]);
    expect(boundaries.remainder()).toBe("\x1b[");
    expect(boundaries.accept("31mred")).toEqual([sequence("\x1b[31m"), text("red")]);
    expect(boundaries.remainder()).toBe("");
  });

  test("recognizes escape, CSI, SS3, and terminated string families", () => {
    const boundaries = openBoundaryScanner();
    expect(
      boundaries.accept(
        "\x1b7\x1b[2;4H\x1bOP\x1b]8;;https://example.test\x07\x1bPdata\x1b\\\x1b_payload\x07",
      ),
    ).toEqual([
      sequence("\x1b7"),
      sequence("\x1b[2;4H"),
      sequence("\x1bOP"),
      sequence("\x1b]8;;https://example.test\x07"),
      sequence("\x1bPdata\x1b\\"),
      sequence("\x1b_payload\x07"),
    ]);
  });

  test("drain emits an incomplete sequence and clear discards it", () => {
    const boundaries = openBoundaryScanner();
    expect(boundaries.accept("\x1b]title")).toEqual([]);
    expect(boundaries.drain()).toEqual([sequence("\x1b]title")]);
    expect(boundaries.remainder()).toBe("");
    expect(boundaries.accept("\x1b[")).toEqual([]);
    boundaries.clear();
    expect(boundaries.remainder()).toBe("");
    expect(boundaries.accept("A")).toEqual([text("A")]);
  });

  test("returns malformed sequences to text and preserves unknown complete sequences", () => {
    const boundaries = openBoundaryScanner();
    expect(boundaries.accept("a\x1b[1\x01b")).toEqual([text("a"), text("\x1b[1\x01b")]);
    expect(boundaries.accept("\x1b[999z")).toEqual([sequence("\x1b[999z")]);
  });

  test("consumes exactly three X10 payload bytes only when enabled", () => {
    const mouseBoundaries = openBoundaryScanner({ legacyMousePayload: true });
    expect(mouseBoundaries.accept("\x1b[M ")).toEqual([]);
    expect(mouseBoundaries.remainder()).toBe("\x1b[M ");
    expect(mouseBoundaries.accept("!tail")).toEqual([sequence("\x1b[M !t"), text("ail")]);

    const outputBoundaries = openBoundaryScanner();
    expect(outputBoundaries.accept("\x1b[M !")).toEqual([sequence("\x1b[M"), text(" !")]);
  });

  test("does not absorb a control byte as an X10 payload", () => {
    const boundaries = openBoundaryScanner({ legacyMousePayload: true });
    expect(boundaries.accept("\x1b[M\x1b[201~")).toEqual([
      sequence("\x1b[M"),
      sequence("\x1b[201~"),
    ]);
  });
});
