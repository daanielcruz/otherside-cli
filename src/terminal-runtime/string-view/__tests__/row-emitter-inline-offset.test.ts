import { describe, expect, it } from "bun:test";
import { ModelTerminal } from "@/terminal-runtime/string-view/__tests__/model-terminal.ts";
import { InlineRowPainter } from "@/terminal-runtime/string-view/row-emitter.js";

const WIDE = { width: 40, height: 24 };

function docLines(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `line-${index}`);
}

/**
 * Drives the terminal the way a real one behaves: apply the emitter's bytes and then,
 * separately, the correct terminal would show the tail of the document at the bottom.
 * The inline start offset must not corrupt that.
 */
function tailShouldMatch(startRow: number, height: number): string[] {
  const emitter = new InlineRowPainter();
  const shell = Array.from({ length: startRow }, (_, index) => `shell-${index}`);
  const terminal = new ModelTerminal(height, startRow, shell);

  // Stream from short (no scroll) up through the scroll boundary to tall, one line at
  // a time — the growth path a streaming assistant takes.
  for (let count = 1; count <= height + 6; count++) {
    const lines = docLines(count);
    const { bytes } = emitter.emit(lines, { width: 40, height });
    terminal.feed(bytes);
  }

  return terminal.visible();
}

/**
 * The real streaming shape: a growing entry in the MIDDLE pushes a fixed suffix
 * (prompt + chrome) down, so each step is a rewrite from the insertion point to the
 * end, not a pure append. Drives that through the scroll boundary from a shell offset.
 */
function middleGrowthShouldMatch(startRow: number, height: number): string[] {
  const emitter = new InlineRowPainter();
  const shell = Array.from({ length: startRow }, (_, index) => `shell-${index}`);
  const terminal = new ModelTerminal(height, startRow, shell);

  const prefix = ["settled-0", "settled-1"];
  const suffix = ["> prompt", "chrome-status", "chrome-mode"];
  let visible: string[] = [];
  for (let grown = 0; grown <= height + 4; grown++) {
    const middle = Array.from({ length: grown }, (_, index) => `stream-${index}`);
    const frame = [...prefix, ...middle, ...suffix];
    terminal.feed(emitter.emit(frame, { width: 40, height }).bytes);
    visible = terminal.visible();
  }
  return visible;
}

describe("InlineRowPainter inline start offset", () => {
  it("keeps a mid-document growing entry correct when scrolled (R>0)", () => {
    const height = 20;
    const visible = middleGrowthShouldMatch(5, height);
    const prefix = ["settled-0", "settled-1"];
    const suffix = ["> prompt", "chrome-status", "chrome-mode"];
    const middle = Array.from({ length: height + 4 }, (_, index) => `stream-${index}`);
    const frame = [...prefix, ...middle, ...suffix];
    expect(visible).toEqual(frame.slice(frame.length - height));
  });

  it("keeps the document tail correct when scrolled from a shell offset (R>0)", () => {
    const height = 20;
    const startRow = 5;
    const visible = tailShouldMatch(startRow, height);
    const finalCount = height + 6;
    const expectedTail = docLines(finalCount).slice(finalCount - height);
    // The whole document is taller than the screen, so the visible grid must be
    // exactly its last `height` lines — no duplication, no drift onto shell rows.
    expect(visible).toEqual(expectedTail);
  });

  it("is unaffected when there is no offset (R=0), as a control", () => {
    const height = 20;
    const visible = tailShouldMatch(0, height);
    const finalCount = height + 6;
    expect(visible).toEqual(docLines(finalCount).slice(finalCount - height));
  });

  it("preserves the blank when a user entry is inserted after a settled notice", () => {
    const height = 24;
    const emitter = new InlineRowPainter();
    const terminal = new ModelTerminal(height, 0);
    const frameA = ["c0", "c1", "", "Floated", "", "> prompt", "status", "mode", "", ""];
    terminal.feed(emitter.emit(frameA, { width: 40, height }).bytes);
    // A submitted user message inserts its leading blank + badge after the notice.
    const frameB = [
      "c0",
      "c1",
      "",
      "Floated",
      "",
      "USER",
      "",
      "> prompt",
      "status",
      "mode",
      "",
      "",
    ];
    terminal.feed(emitter.emit(frameB, { width: 40, height }).bytes);
    expect(terminal.visible().slice(0, frameB.length)).toEqual(frameB);
  });

  it("keeps the blank above a user entry settled after a turn notice", () => {
    const height = 24;
    const emitter = new InlineRowPainter();
    const terminal = new ModelTerminal(height, 0);
    const frame = ["", "> prompt", "status", "mode", "", ""];

    terminal.feed(emitter.paintScrollback(["", "assistant reply"], frame, WIDE).bytes);
    terminal.feed(emitter.commitScrollback(["", "Floated for 4s"], frame, WIDE).bytes);
    terminal.feed(emitter.commitScrollback(["", "USER"], frame, WIDE).bytes);

    const document = terminal.visible().slice(0, 7);
    expect(document).toEqual(["", "assistant reply", "", "Floated for 4s", "", "USER", ""]);
  });

  it("creates rows the document grew into, so later frames land where the model says", () => {
    const height = 24;
    const emitter = new InlineRowPainter();
    const terminal = new ModelTerminal(height, 0);
    // The frame ends in blanks, so a growing document lands new rows whose text
    // matches the blank already read at that index — the row must still be created.
    const frame = ["", "> prompt", "status", "mode", "", ""];

    terminal.feed(emitter.paintScrollback(["reply"], frame, WIDE).bytes);
    terminal.feed(emitter.commitScrollback(["", "¤ Floated for 4s"], frame, WIDE).bytes);
    terminal.feed(emitter.commitScrollback(["", "❯ USER"], frame, WIDE).bytes);
    terminal.feed(emitter.emitFrame(["", "> prompt x", "status", "mode", "", ""], WIDE).bytes);

    expect(terminal.visible().slice(0, 10)).toEqual([
      "reply",
      "",
      "¤ Floated for 4s",
      "",
      "❯ USER",
      "",
      "> prompt x",
      "status",
      "mode",
      "",
    ]);
  });

  it("preserves the blank when a user entry is inserted in a scrolled frame", () => {
    const height = 10;
    const emitter = new InlineRowPainter();
    const terminal = new ModelTerminal(height, 0);
    const filler = Array.from({ length: 14 }, (_, index) => `f${index}`);
    const frameA = [...filler, "", "Floated", "> prompt", "status", "mode"];
    terminal.feed(emitter.emit(frameA, { width: 40, height }).bytes);
    const frameB = [...filler, "", "Floated", "", "USER", "> prompt", "status", "mode"];
    terminal.feed(emitter.emit(frameB, { width: 40, height }).bytes);
    expect(terminal.visible()).toEqual(frameB.slice(frameB.length - height));
  });
});
