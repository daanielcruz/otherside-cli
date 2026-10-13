import { sharedGraphemeSegmenter } from "@/kernel/std/intl.ts";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";

/** One grapheme per cell; the cell a wide glyph spills into holds "". */
type ScreenRow = string[];

/**
 * A minimal terminal whose cursor starts at `startRow` — the inline offset a real
 * shell leaves above the first rendered line. It interprets exactly the byte
 * vocabulary the emitter emits (text, CR/LF, cursor movement, erase-line, the
 * full-redraw clear, and synchronized-output markers) so a frame's rendered result can be read
 * back and compared to what a correct terminal would show.
 *
 * Given `columns`, text that runs past the last cell soft-wraps onto the next row the
 * way a real terminal's autowrap does, measured in cells, so a wide glyph that does not
 * fit the last cell moves down whole.
 */
export class ModelTerminal {
  private readonly screen: ScreenRow[];
  private row: number;
  private col = 0;

  constructor(
    private readonly height: number,
    startRow = 0,
    shell: readonly string[] = [],
    private readonly columns = Number.POSITIVE_INFINITY,
  ) {
    this.screen = Array.from({ length: height }, (_, index) => cellsOf(shell[index] ?? ""));
    this.row = Math.max(0, Math.min(height - 1, startRow));
  }

  visible(): string[] {
    return this.screen.map((cells) => cells.join("").replace(/\s+$/u, ""));
  }

  /** Screen row the hardware cursor sits on — the emitter's model must agree with it. */
  cursorRow(): number {
    return this.row;
  }

  /** Column the hardware cursor rests on, which is where a dead key composes. */
  cursorColumn(): number {
    return this.col;
  }

  feed(bytes: string): void {
    let index = 0;
    while (index < bytes.length) {
      const char = bytes[index]!;
      if (char === "\x1b") {
        index = this.applyEscape(bytes, index);
        continue;
      }
      if (char === "\r") {
        this.col = 0;
        index += 1;
        continue;
      }
      if (char === "\n") {
        this.lineFeed();
        index += 1;
        continue;
      }
      const nextControl = this.nextControlIndex(bytes, index);
      this.writeText(bytes.slice(index, nextControl));
      index = nextControl;
    }
  }

  private nextControlIndex(bytes: string, from: number): number {
    for (let index = from; index < bytes.length; index++) {
      const char = bytes[index]!;
      if (char === "\x1b" || char === "\r" || char === "\n") return index;
    }
    return bytes.length;
  }

  private applyEscape(bytes: string, start: number): number {
    // CSI: ESC [ params... finalByte
    if (bytes[start + 1] !== "[") return start + 1;
    let index = start + 2;
    let params = "";
    while (index < bytes.length && /[0-9;?]/u.test(bytes[index]!)) {
      params += bytes[index];
      index += 1;
    }
    const final = bytes[index];
    index += 1;
    switch (final) {
      case "A":
        this.row = Math.max(0, this.row - numParam(params, 1));
        break;
      case "B":
        this.row = Math.min(this.height - 1, this.row + numParam(params, 1));
        break;
      case "C":
        this.col += numParam(params, 1);
        break;
      case "H":
        this.row = Math.max(0, Math.min(this.height - 1, numParam(params, 1) - 1));
        this.col = Math.max(0, numParam(params.split(";")[1] ?? "", 1) - 1);
        break;
      case "K":
        if (params === "2") this.screen[this.row] = [];
        break;
      case "J":
        if (params === "2") this.eraseScreen();
        break;
      // SGR ("m"), synchronized output ("?2026h"/"?2026l"), scrollback erase ("3J")
      // move nothing on the visible grid.
    }
    return index;
  }

  private eraseScreen(): void {
    for (let row = 0; row < this.screen.length; row++) this.screen[row] = [];
  }

  private lineFeed(): void {
    if (this.row >= this.height - 1) {
      this.screen.shift();
      this.screen.push([]);
      this.row = this.height - 1;
    } else {
      this.row += 1;
    }
  }

  private writeText(run: string): void {
    for (const { segment } of sharedGraphemeSegmenter().segment(stripAnsi(run))) {
      const cells = stringWidth(segment);
      if (cells === 0) continue;
      if (this.col + cells > this.columns) {
        this.col = 0;
        this.lineFeed();
      }
      this.writeCell(segment, cells);
    }
  }

  private writeCell(grapheme: string, cells: number): void {
    const row = this.screen[this.row] ?? [];
    while (row.length < this.col + cells) row.push(" ");
    row[this.col] = grapheme;
    if (cells === 2) row[this.col + 1] = "";
    this.screen[this.row] = row;
    this.col += cells;
  }
}

function cellsOf(text: string): ScreenRow {
  const row: ScreenRow = [];
  for (const { segment } of sharedGraphemeSegmenter().segment(text)) {
    row.push(segment);
    if (stringWidth(segment) === 2) row.push("");
  }
  return row;
}

function numParam(params: string, fallback: number): number {
  const first = params.split(";")[0] ?? "";
  const value = Number.parseInt(first, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
