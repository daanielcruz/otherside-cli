import { expect, test } from "bun:test";
import { ModelTerminal } from "@/terminal-runtime/string-view/__tests__/model-terminal.ts";
import { InlineRowPainter } from "@/terminal-runtime/string-view/row-emitter.js";

const BEGIN_SYNC = "\x1b[?2026h";
const END_SYNC = "\x1b[?2026l";
const EL2 = "\x1b[2K";
const FULL_RESET = "\x1b[2J\x1b[H\x1b[3J";
const GEOMETRY = { width: 20, height: 6 };

test("first emit appends rows without erasing or synchronized output", () => {
  const emitter = new InlineRowPainter();

  expect(emitter.emit(["one", "two"], GEOMETRY).bytes).toBe("one\r\ntwo");
});

test("pure append clears and writes only rows after the previous last row", () => {
  const emitter = new InlineRowPainter();
  emitter.emit(["one", "two"], GEOMETRY);

  const bytes = emitter.emit(["one", "two", "three", "four"], GEOMETRY).bytes;

  expect(bytes).toBe(`\r\n${EL2}three\r\n${EL2}four`);
  expect(bytes).not.toContain("\x1b[2J");
  expect(bytes).not.toContain(BEGIN_SYNC);
});

test("differential rewrite moves relatively and rewrites the changed middle range", () => {
  const emitter = new InlineRowPainter();
  emitter.emit(["a", "b", "c", "d"], GEOMETRY);

  const bytes = emitter.emit(["a", "B", "C", "d"], GEOMETRY).bytes;

  expect(bytes).toBe(`${BEGIN_SYNC}\x1b[2A\r${EL2}B\r\n${EL2}C${END_SYNC}`);
  expect(bytes).not.toContain("\x1b[2J");
  expect(bytes).not.toMatch(/\x1b\[[0-9]+;[0-9]+H/);
});

test("width change uses synchronized full redraw with ordered destructive reset", () => {
  const emitter = new InlineRowPainter();
  emitter.emit(["one"], GEOMETRY);

  const bytes = emitter.emit(["one"], { ...GEOMETRY, width: 10 }).bytes;

  expect(bytes).toBe(`${BEGIN_SYNC}${FULL_RESET}\x1b[6;1Hone${END_SYNC}`);
  expect(bytes.indexOf("\x1b[2J")).toBeLessThan(bytes.indexOf("\x1b[H"));
  expect(bytes.indexOf("\x1b[H")).toBeLessThan(bytes.indexOf("\x1b[3J"));
});

test("shrink clears vacated rows differentially and preserves the viewport top", () => {
  const emitter = new InlineRowPainter();
  emitter.emit(["zero", "one", "two", "three", "four"], { width: 20, height: 3 });

  const bytes = emitter.emit(["zero", "one", "two", "three"], {
    width: 20,
    height: 3,
  }).bytes;

  expect(bytes).toBe(`${BEGIN_SYNC}\x1b[1A\r\x1b[1B\r${EL2}\x1b[1A${END_SYNC}`);
  expect(bytes).not.toContain("\x1b[2J");
  expect(bytes).not.toContain("\x1b[3J");

  const followUp = emitter.emit(["zero", "ONE", "two", "three"], {
    width: 20,
    height: 3,
  }).bytes;
  expect(followUp).toStartWith(BEGIN_SYNC);
});

test("a change confined above the viewport top is left in history, not redrawn", () => {
  const emitter = new InlineRowPainter();
  emitter.emit(["zero", "one", "two", "three", "four"], { width: 20, height: 3 });

  const bytes = emitter.emit(["zero", "ONE", "two", "three", "four"], {
    width: 20,
    height: 3,
  }).bytes;

  // Row 1 has scrolled into history, which no cursor move can reach. Rebuilding it
  // would take the destructive reset that costs the user their scrollback, so the row
  // stays as history recorded it and nothing is written.
  expect(bytes).toBe("");
});

test("a change reaching into the viewport repaints only the rows still on screen", () => {
  const emitter = new InlineRowPainter();
  emitter.emit(["zero", "one", "two", "three", "four"], { width: 20, height: 3 });

  const bytes = emitter.emit(["zero", "ONE", "two", "THREE", "four"], {
    width: 20,
    height: 3,
  }).bytes;

  // The span opens above the viewport and ends inside it: the repaint starts at the
  // first reachable row, so `ONE` is skipped and `THREE` is written where it stands.
  expect(bytes).not.toContain("\x1b[2J");
  expect(bytes).not.toContain("\x1b[3J");
  expect(bytes).not.toContain("ONE");
  expect(bytes).toContain("THREE");
});

test("reference-identical rows are omitted from the rewritten range", () => {
  const first = "stable-first";
  const last = "stable-last";
  const emitter = new InlineRowPainter();
  emitter.emit([first, "before", last], GEOMETRY);

  const bytes = emitter.emit([first, "after", last], GEOMETRY).bytes;

  expect(bytes).toBe(`${BEGIN_SYNC}\x1b[1A\r${EL2}after${END_SYNC}`);
  expect(bytes).not.toContain(first);
  expect(bytes).not.toContain(last);
});

test("identical frames emit no bytes", () => {
  const first = "one";
  const second = "two";
  const emitter = new InlineRowPainter();
  emitter.emit([first, second], GEOMETRY);

  expect(emitter.emit([first, second], GEOMETRY)).toEqual({ bytes: "" });
});

test("invalidating terminal memory requests a synchronized full redraw", () => {
  const emitter = new InlineRowPainter();
  emitter.emit(["one"], GEOMETRY);
  emitter.invalidateTerminalMemory();

  expect(emitter.emit(["two"], GEOMETRY).bytes).toBe(
    `${BEGIN_SYNC}${FULL_RESET}\x1b[6;1Htwo${END_SYNC}`,
  );
});

test("settled rows are painted once while later frame updates stay differential", () => {
  const emitter = new InlineRowPainter();
  emitter.paintScrollback(["settled-one"], ["prompt"], GEOMETRY);

  const settlement = emitter.commitScrollback(["settled-two"], ["prompt"], GEOMETRY).bytes;
  expect(settlement.match(/settled-two/g)).toHaveLength(1);
  expect(emitter.emitFrame(["prompt"], GEOMETRY).bytes).toBe("");

  const keystroke = emitter.emitFrame(["prompt x"], GEOMETRY).bytes;
  expect(keystroke).toContain("prompt x");
  expect(keystroke).not.toContain("settled-one");
  expect(keystroke).not.toContain("settled-two");
});

test("keystroke comparison cost is bounded by frame rows after a large settled document", () => {
  const comparedRows: number[] = [];
  const emitter = new InlineRowPainter({ onCompareRow: (row) => comparedRows.push(row) });
  const settled = Array.from({ length: 10_000 }, (_, row) => `settled-${row}`);
  emitter.paintScrollback(settled, ["live", "prompt", "chrome"], GEOMETRY);
  comparedRows.length = 0;

  emitter.emitFrame(["live", "prompt x", "chrome"], GEOMETRY);

  expect(comparedRows.length).toBeLessThanOrEqual(6);
  expect(Math.max(...comparedRows)).toBeLessThan(3);
});

test("settling a heavy tool result costs its own rows, not the history above it", () => {
  const comparedRows: number[] = [];
  const emitter = new InlineRowPainter({ onCompareRow: (row) => comparedRows.push(row) });
  const settled = Array.from({ length: 10_000 }, (_, row) => `settled-${row}`);
  emitter.paintScrollback(settled, ["live", "prompt"], GEOMETRY);
  comparedRows.length = 0;

  const toolRows = Array.from({ length: 3_000 }, (_, row) => `  output line ${row}`);
  emitter.commitScrollback(toolRows, ["live", "prompt"], GEOMETRY);

  // The tool's own rows plus the frame — the settled history is never revisited.
  expect(comparedRows.length).toBeLessThanOrEqual(toolRows.length + 10);
});

test("document rebuild repaints settled rows and frame after resize", () => {
  const emitter = new InlineRowPainter();
  emitter.paintScrollback(["wide settled"], ["wide prompt"], GEOMETRY);

  const bytes = emitter.paintScrollback(["narrow", "settled"], ["narrow prompt"], {
    ...GEOMETRY,
    width: 10,
  }).bytes;

  expect(bytes).toBe(
    `${BEGIN_SYNC}${FULL_RESET}narrow\r\nsettled\x1b[6;1Hnarrow prompt${END_SYNC}`,
  );
});

test("surface switches keep short agent frames at the viewport bottom", () => {
  const emitter = new InlineRowPainter();
  const terminal = new ModelTerminal(GEOMETRY.height);
  const paintSwitch = (history: readonly string[], frame: readonly string[]): string => {
    const bytes = emitter.paintScrollback(history, frame, GEOMETRY, true).bytes;
    terminal.feed(bytes);
    return bytes;
  };

  terminal.feed(emitter.paintScrollback(["main settled"], ["main prompt"], GEOMETRY).bytes);

  const entering = paintSwitch(["agent settled"], ["agent prompt", "agent footer"]);
  expect(entering).toContain(FULL_RESET);
  expect(terminal.visible()).toEqual(["agent settled", "", "", "", "agent prompt", "agent footer"]);

  terminal.feed(emitter.emitFrame(["agent typing", "agent footer"], GEOMETRY).bytes);
  expect(terminal.visible()).toEqual(["agent settled", "", "", "", "agent typing", "agent footer"]);

  const exiting = paintSwitch(["main settled"], ["main prompt", "main footer"]);
  expect(exiting).toContain(FULL_RESET);
  expect(terminal.visible()).toEqual(["main settled", "", "", "", "main prompt", "main footer"]);

  const reenteringMidTurn = paintSwitch(
    ["agent settled"],
    ["agent streaming", "agent prompt", "agent footer"],
  );
  expect(reenteringMidTurn).toContain(FULL_RESET);
  expect(reenteringMidTurn.match(/agent settled/g)).toHaveLength(1);
  expect(terminal.visible()).toEqual([
    "agent settled",
    "",
    "",
    "agent streaming",
    "agent prompt",
    "agent footer",
  ]);
});
