/**
 * Deterministic terminal emulator for renderer tests: a physical W×H grid
 * plus unbounded scrollback, interpreting exactly the escape subset the ink
 * writer emits (see src/ink/termio/csi.ts and src/ink/terminal.ts). Rows
 * that scroll off the top land in scrollback verbatim; erases clear grid
 * cells but never touch scrollback — the same contract as a real terminal,
 * which is what the tmux-only reproductions could not assert against.
 */
export class TerminalEmulator {
  private width: number;
  private height: number;
  private grid: string[][] = [];
  private cursorX = 0;
  private cursorY = 0;
  readonly scrollbackLines: string[] = [];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.reset();
  }

  private reset(): void {
    this.grid = Array.from({ length: this.height }, () => this.blankRow());
    this.cursorX = 0;
    this.cursorY = 0;
  }

  private blankRow(): string[] {
    return new Array<string>(this.width).fill(" ");
  }

  get columns(): number {
    return this.width;
  }

  get rows(): number {
    return this.height;
  }

  get cursor(): { x: number; y: number } {
    return { x: this.cursorX, y: this.cursorY };
  }

  /** Truncate/pad resize (tmux-like; no reflow — deterministic). */
  resize(width: number, height: number): void {
    const oldRows = this.grid;
    if (height < this.height) {
      // Height shrink follows tmux/xterm: blank rows below the cursor are
      // cropped first; only the remaining excess scrolls top rows out. An
      // unconditional top-push would fabricate scrollback for content that
      // never scrolled (the early-conversation case).
      let excess = this.height - height;
      while (
        excess > 0 &&
        oldRows.length > 0 &&
        this.cursorY < oldRows.length - 1 &&
        (oldRows[oldRows.length - 1] as string[]).join("").trim() === ""
      ) {
        oldRows.pop();
        excess--;
      }
      for (let i = 0; i < excess; i++) {
        const row = oldRows.shift();
        if (row) this.scrollbackLines.push(row.join("").trimEnd());
        this.cursorY = Math.max(0, this.cursorY - 1);
      }
    } else if (height > this.height) {
      for (let i = this.height; i < height; i++) oldRows.push(this.blankRow());
    }
    this.height = height;
    this.width = width;
    this.grid = oldRows.map((row) => {
      const line = row.join("");
      const next = this.blankRow();
      for (let x = 0; x < Math.min(width, line.length); x++) {
        next[x] = line[x] as string;
      }
      return next;
    });
    this.cursorX = Math.min(this.cursorX, width - 1);
    this.cursorY = Math.min(this.cursorY, height - 1);
  }

  write(chunk: string): void {
    let i = 0;
    while (i < chunk.length) {
      const ch = chunk[i] as string;
      if (ch === "\x1b") {
        const consumed = this.consumeEscape(chunk, i);
        i += consumed;
        continue;
      }
      if (ch === "\r") {
        this.cursorX = 0;
        i++;
        continue;
      }
      if (ch === "\n") {
        // ONLCR: the tty driver maps NL to CR+NL, which is the mode the CLI
        // always runs under (static-flush text relies on it).
        this.cursorX = 0;
        this.lineFeed();
        i++;
        continue;
      }
      if (ch === "\x07" || ch === "\x00") {
        i++;
        continue;
      }
      this.printChar(ch);
      i++;
    }
  }

  private printChar(ch: string): void {
    if (this.cursorX >= this.width) {
      // Deferred wrap: printing past the right edge moves to the next line.
      this.cursorX = 0;
      this.lineFeed();
    }
    const row = this.grid[this.cursorY];
    if (row) row[this.cursorX] = ch;
    this.cursorX++;
  }

  private lineFeed(): void {
    if (this.cursorY === this.height - 1) {
      const top = this.grid.shift();
      if (top) this.scrollbackLines.push(top.join("").trimEnd());
      this.grid.push(this.blankRow());
    } else {
      this.cursorY++;
    }
  }

  private consumeEscape(chunk: string, start: number): number {
    const next = chunk[start + 1];
    if (next === "[") {
      let j = start + 2;
      while (j < chunk.length && !/[A-Za-z~]/.test(chunk[j] as string)) j++;
      const params = chunk.slice(start + 2, j);
      const final = chunk[j] as string;
      this.applyCSI(params, final);
      return j - start + 1;
    }
    if (next === "]") {
      // OSC: consume through BEL or ST.
      let j = start + 2;
      while (j < chunk.length && chunk[j] !== "\x07") {
        if (chunk[j] === "\x1b" && chunk[j + 1] === "\\") {
          return j + 2 - start;
        }
        j++;
      }
      return j + 1 - start;
    }
    // ESC 7 / ESC 8 / others: single following byte.
    return 2;
  }

  private applyCSI(params: string, final: string): void {
    const first = Number.parseInt(params.split(";")[0] || "1", 10);
    switch (final) {
      case "A":
        this.cursorY = Math.max(0, this.cursorY - (Number.isNaN(first) ? 1 : first));
        break;
      case "B":
        this.cursorY = Math.min(this.height - 1, this.cursorY + (Number.isNaN(first) ? 1 : first));
        break;
      case "C":
        this.cursorX = Math.min(this.width, this.cursorX + (Number.isNaN(first) ? 1 : first));
        break;
      case "D":
        this.cursorX = Math.max(0, this.cursorX - (Number.isNaN(first) ? 1 : first));
        break;
      case "G":
        this.cursorX = Math.max(0, Math.min(this.width - 1, (Number.isNaN(first) ? 1 : first) - 1));
        break;
      case "H": {
        const parts = params.split(";");
        const row = Number.parseInt(parts[0] || "1", 10) || 1;
        const col = Number.parseInt(parts[1] || "1", 10) || 1;
        this.cursorY = Math.max(0, Math.min(this.height - 1, row - 1));
        this.cursorX = Math.max(0, Math.min(this.width - 1, col - 1));
        break;
      }
      case "K": {
        const mode = params === "" ? 0 : first;
        const row = this.grid[this.cursorY];
        if (!row) break;
        if (mode === 0) for (let x = this.cursorX; x < this.width; x++) row[x] = " ";
        else if (mode === 1) for (let x = 0; x <= this.cursorX; x++) row[x] = " ";
        else if (mode === 2) for (let x = 0; x < this.width; x++) row[x] = " ";
        break;
      }
      case "J": {
        const mode = params === "" ? 0 : first;
        if (mode === 0) {
          const row = this.grid[this.cursorY];
          if (row) for (let x = this.cursorX; x < this.width; x++) row[x] = " ";
          for (let y = this.cursorY + 1; y < this.height; y++) this.grid[y] = this.blankRow();
        } else if (mode === 2) {
          for (let y = 0; y < this.height; y++) this.grid[y] = this.blankRow();
        } else if (mode === 3) {
          this.scrollbackLines.length = 0;
        }
        break;
      }
      case "S": {
        const n = Number.isNaN(first) ? 1 : first;
        for (let i = 0; i < n; i++) {
          const top = this.grid.shift();
          if (top) this.scrollbackLines.push(top.join("").trimEnd());
          this.grid.push(this.blankRow());
        }
        break;
      }
      default:
        // SGR (m), modes (h/l), scroll region (r), etc.: layout-neutral here.
        break;
    }
  }

  visibleLines(): string[] {
    return this.grid.map((row) => row.join("").trimEnd());
  }

  visibleText(): string {
    return this.visibleLines().join("\n");
  }

  allText(): string {
    return [...this.scrollbackLines, ...this.visibleLines()].join("\n");
  }

  countOccurrences(needle: string): number {
    return this.allText().split(needle).length - 1;
  }

  visibleRowOf(needle: string): number {
    return this.visibleLines().findIndex((line) => line.includes(needle));
  }
}
