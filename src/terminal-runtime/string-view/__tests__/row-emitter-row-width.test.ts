import { describe, expect, test } from "bun:test";
import { ModelTerminal } from "@/terminal-runtime/string-view/__tests__/model-terminal.ts";
import { InlineRowPainter } from "@/terminal-runtime/string-view/row-emitter.js";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";

const WIDTH = 40;
const HEIGHT = 14;
const SPINNER_GLYPHS = ["◳", "◲", "◱", "◰"];
const PANEL = ["", "  Which color do you prefer?", "  ❯ 1. Red", "    2. Blue", ""];
const PROMPT = ["❯ answer", "  status"];

/** A spinner row wider than the terminal, the way a long reasoning title renders. */
function spinnerRow(frame: number): string {
  const glyph = SPINNER_GLYPHS[frame % SPINNER_GLYPHS.length];
  return `${glyph} Adjusting the question call… (16s · ↓ ${183 + frame * 3} tokens · reasoned for 5s)`;
}

/** Feeds each frame through the painter into a terminal that soft-wraps at WIDTH. */
class LiveSurface {
  private readonly painter = new InlineRowPainter();
  readonly terminal = new ModelTerminal(HEIGHT, 0, [], WIDTH);

  paint(frame: readonly string[]): void {
    const caret = { row: frame.length - PROMPT.length, column: 8 };
    this.terminal.feed(
      this.painter.emitFrame(frame, { width: WIDTH, height: HEIGHT, caret }).bytes,
    );
  }

  rowsContaining(text: string): string[] {
    return this.terminal.visible().filter((row) => row.includes(text));
  }
}

describe("rows wider than the terminal", () => {
  test("an over-wide spinner row is repainted in place instead of stacking over the panel", () => {
    const surface = new LiveSurface();

    for (let frame = 0; frame < 4; frame++) {
      surface.paint([spinnerRow(frame), ...PANEL, ...PROMPT]);
    }

    const screen = surface.terminal.visible();
    expect(surface.rowsContaining("Adjusting")).toHaveLength(1);
    expect(screen[0]).toStartWith(`${SPINNER_GLYPHS[3]} Adjusting`);
    expect(screen.slice(1, 1 + PANEL.length + PROMPT.length)).toEqual([...PANEL, ...PROMPT]);
  });

  test("closing a panel under an over-wide row leaves none of its rows behind", () => {
    const surface = new LiveSurface();
    surface.paint([spinnerRow(0), ...PANEL, ...PROMPT]);
    surface.paint([spinnerRow(1), ...PANEL, ...PROMPT]);

    surface.paint([spinnerRow(2), "", ...PROMPT]);

    const screen = surface.terminal.visible();
    expect(surface.rowsContaining("Adjusting")).toHaveLength(1);
    expect(surface.rowsContaining("Which color")).toEqual([]);
    expect(screen.slice(1, 2 + PROMPT.length)).toEqual(["", ...PROMPT]);
  });

  test("wide glyphs count as two cells when a row is fitted to the width", () => {
    const surface = new LiveSurface();
    // Fewer code units than the width, but twice as many cells.
    const wideRow = (frame: number) => `${"界".repeat(24)} ${frame}`;

    for (let frame = 0; frame < 3; frame++) surface.paint([wideRow(frame), ...PANEL, ...PROMPT]);

    const screen = surface.terminal.visible();
    expect(surface.rowsContaining("界")).toHaveLength(1);
    expect(stringWidth(screen[0] ?? "")).toBeLessThanOrEqual(WIDTH);
    expect(screen.slice(1, 1 + PANEL.length + PROMPT.length)).toEqual([...PANEL, ...PROMPT]);
  });

  test("a regenerated surface anchors its live frame below an over-wide settled row", () => {
    const height = 6;
    const painter = new InlineRowPainter();
    const terminal = new ModelTerminal(height, 0, [], WIDTH);
    const geometry = { width: WIDTH, height };
    const settled = [`⏺ ${"settled output ".repeat(4)}`, "  one", "  two", "  three"];
    terminal.feed(painter.paintScrollback([], PROMPT, geometry).bytes);

    terminal.feed(painter.paintScrollback(settled, PROMPT, geometry, true).bytes);

    expect(terminal.visible().slice(1)).toEqual(["  one", "  two", "  three", ...PROMPT]);
  });

  test("the cursor the terminal holds agrees with the row the painter parked on", () => {
    const painter = new InlineRowPainter();
    const terminal = new ModelTerminal(HEIGHT, 0, [], WIDTH);
    const geometry = { width: WIDTH, height: HEIGHT, caret: { row: 6, column: 8 } };

    for (let frame = 0; frame < 3; frame++) {
      terminal.feed(painter.emitFrame([spinnerRow(frame), ...PANEL, ...PROMPT], geometry).bytes);
    }

    expect(terminal.cursorRow() + 1).toBe(painter.parkedScreenRow() ?? -1);
  });
});
