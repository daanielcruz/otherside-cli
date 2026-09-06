import { describe, expect, test } from "bun:test";
import { ModelTerminal } from "@/terminal-runtime/string-view/__tests__/model-terminal.ts";
import { InlineRowPainter } from "@/terminal-runtime/string-view/row-emitter.js";

const END_SYNC = "\x1b[?2026l";
const GEOMETRY = { width: 20, height: 8 };

/**
 * Where the bytes leave the real cursor. The terminal draws a pending dead-key
 * composition there, so this is the position the accent lands on — the reason the
 * park exists at all.
 */
function restingCursor(bytes: string, height: number): [number, number] {
  const terminal = new ModelTerminal(height);
  terminal.feed(bytes);
  return [terminal.cursorRow(), terminal.cursorColumn()];
}

/** Feeds every paint in order, then reports where the cursor came to rest. */
function driveTerminal(height: number, paints: readonly string[]): ModelTerminal {
  const terminal = new ModelTerminal(height);
  for (const bytes of paints) terminal.feed(bytes);
  return terminal;
}

describe("caret park", () => {
  test("a first paint leaves the cursor on the caret, not on the last row", () => {
    const emitter = new InlineRowPainter();
    const frame = ["", "> hi", "status"];

    const { bytes } = emitter.emitFrame(frame, { ...GEOMETRY, caret: { row: 1, column: 4 } });

    expect(restingCursor(bytes, GEOMETRY.height)).toEqual([1, 4]);
  });

  test("a frame update parks inside the synchronized wrapper", () => {
    const emitter = new InlineRowPainter();
    const first = emitter.emitFrame(["", "> hi", "status"], {
      ...GEOMETRY,
      caret: { row: 1, column: 4 },
    });
    const second = emitter.emitFrame(["", "> hey", "status"], {
      ...GEOMETRY,
      caret: { row: 1, column: 5 },
    });

    // The park must precede the terminator, or the terminal applies the move after
    // it has already flushed the frame and the caret visibly jumps into place.
    expect(second.bytes.endsWith(END_SYNC)).toBe(true);
    expect(second.bytes.slice(0, -END_SYNC.length)).toContain("\r");

    const terminal = driveTerminal(GEOMETRY.height, [first.bytes, second.bytes]);
    expect([terminal.cursorRow(), terminal.cursorColumn()]).toEqual([1, 5]);
  });

  test("a settle parks on the caret in the frame, past the rows it appended", () => {
    const emitter = new InlineRowPainter();
    const frame = ["", "> hi", "status"];
    const caret = { row: 1, column: 4 };
    const boot = emitter.paintScrollback(["welcome"], frame, { ...GEOMETRY, caret });
    const settled = emitter.commitScrollback(["", "a tool ran"], frame, { ...GEOMETRY, caret });

    const terminal = driveTerminal(GEOMETRY.height, [boot.bytes, settled.bytes]);

    // The caret's own row moved down as the settle appended above it; the cursor
    // has to follow it there rather than stay at the row the diff last wrote.
    expect(terminal.visible()[terminal.cursorRow()]).toBe("> hi");
    expect(terminal.cursorColumn()).toBe(4);
  });

  test("the parked row is tracked, so the next move measures from the caret", () => {
    const emitter = new InlineRowPainter();
    const caret = { row: 1, column: 4 };
    const first = emitter.emitFrame(["", "> hi", "status", "mode"], { ...GEOMETRY, caret });
    const second = emitter.emitFrame(["", "> hi", "status", "MODE"], { ...GEOMETRY, caret });

    // Reaching the last row means descending two from the parked caret row. A model
    // that still believed the cursor sat on the last row would not move at all, and
    // would erase the caret's row instead.
    expect(second.bytes.indexOf("\x1b[2B")).toBeLessThan(second.bytes.indexOf("MODE"));

    const terminal = driveTerminal(GEOMETRY.height, [first.bytes, second.bytes]);
    expect(terminal.visible().slice(0, 4)).toEqual(["", "> hi", "status", "MODE"]);
    expect([terminal.cursorRow(), terminal.cursorColumn()]).toEqual([1, 4]);
  });

  test("no caret leaves every byte exactly as it was", () => {
    const parked = new InlineRowPainter();
    const plain = new InlineRowPainter();
    const frame = ["a", "b", "c"];
    parked.emitFrame(frame, GEOMETRY);
    plain.emitFrame(frame, GEOMETRY);

    expect(parked.emitFrame(["a", "B", "c"], { ...GEOMETRY, caret: null }).bytes).toBe(
      plain.emitFrame(["a", "B", "c"], GEOMETRY).bytes,
    );
  });

  test("an unchanged frame writes nothing, since the cursor is already parked", () => {
    const emitter = new InlineRowPainter();
    const frame = ["", "> hi", "status"];
    const caret = { row: 1, column: 4 };
    emitter.emitFrame(frame, { ...GEOMETRY, caret });

    expect(emitter.emitFrame(frame, { ...GEOMETRY, caret }).bytes).toBe("");
  });
});
