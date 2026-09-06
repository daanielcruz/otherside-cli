import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { isInsertable } from "@/ui/chrome/key-input.ts";

const HALF_PAGE_DIVISOR = 2;

function clampOffset(offset: number, total: number, rows: number): number {
  return Math.max(0, Math.min(offset, total - rows));
}

/**
 * Viewport state for a full-screen reader over already-rendered rows.
 *
 * The window is pinned to the last row until a key moves it, so the reader opens on
 * the newest content and only stops following once the user starts navigating. A
 * search is a line filter over the same rows: `/` opens the query, `n`/`N` walk the
 * matching rows and park each one on the first visible line.
 */
export class DetailedTranscriptPager {
  private lines: readonly string[] = [];
  private offset = 0;
  private pinnedToEnd = true;
  private query = "";
  private typingQuery = false;

  setContent(lines: readonly string[]): void {
    this.lines = lines;
  }

  reset(): void {
    this.offset = 0;
    this.pinnedToEnd = true;
    this.query = "";
    this.typingQuery = false;
  }

  isSearching(): boolean {
    return this.typingQuery;
  }

  searchQuery(): string {
    return this.query;
  }

  /** The rows to draw, clamped to the content and remembered as the live offset. */
  window(height: number): readonly string[] {
    const rows = Math.max(1, height);
    const target = this.pinnedToEnd ? this.lines.length : this.offset;
    this.offset = clampOffset(target, this.lines.length, rows);
    return this.lines.slice(this.offset, this.offset + rows);
  }

  /** Whether the pager owns the key; anything else falls through to the reader. */
  handleKey(key: KeyEventData, height: number): boolean {
    const rows = Math.max(1, height);
    if (this.typingQuery) return this.handleQueryKey(key, rows);
    if (key.ctrl) return this.handleControlKey(key, rows);
    if (key.meta || key.option) return false;
    if (key.name === "up") return this.scrollBy(-1, rows);
    if (key.name === "down") return this.scrollBy(1, rows);
    if (key.name === "home") return this.jumpTo("top", rows);
    if (key.name === "end") return this.jumpTo("bottom", rows);
    if (key.name === "space") return this.scrollBy(rows, rows);
    return this.handleLetterKey(key, rows);
  }

  private handleControlKey(key: KeyEventData, rows: number): boolean {
    const half = Math.max(1, Math.floor(rows / HALF_PAGE_DIVISOR));
    if (key.name === "d") return this.scrollBy(half, rows);
    if (key.name === "u") return this.scrollBy(-half, rows);
    if (key.name === "f") return this.scrollBy(rows, rows);
    if (key.name === "b") return this.scrollBy(-rows, rows);
    return false;
  }

  private handleLetterKey(key: KeyEventData, rows: number): boolean {
    switch (key.sequence) {
      case "j":
        return this.scrollBy(1, rows);
      case "k":
        return this.scrollBy(-1, rows);
      case "b":
        return this.scrollBy(-rows, rows);
      case "g":
        return this.jumpTo("top", rows);
      case "G":
        return this.jumpTo("bottom", rows);
      case "n":
        return this.jumpToMatch(1, rows);
      case "N":
        return this.jumpToMatch(-1, rows);
      case "/":
        this.typingQuery = true;
        this.query = "";
        return true;
      default:
        return false;
    }
  }

  private handleQueryKey(key: KeyEventData, rows: number): boolean {
    if (key.name === "escape") {
      this.typingQuery = false;
      this.query = "";
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      this.typingQuery = false;
      return true;
    }
    if (key.name === "backspace" || key.name === "delete") {
      if (this.query.length === 0) this.typingQuery = false;
      else this.setQuery(this.query.slice(0, -1), rows);
      return true;
    }
    const sequence = key.sequence;
    if (!key.ctrl && !key.meta && sequence !== undefined && isInsertable(sequence)) {
      this.setQuery(this.query + sequence, rows);
    }
    // A search box owns every key while it is open, so nothing leaks to the reader.
    return true;
  }

  private setQuery(query: string, rows: number): void {
    this.query = query;
    const first = this.matchingLines().at(0);
    if (first !== undefined) this.showLine(first, rows);
  }

  private matchingLines(): number[] {
    if (this.query.length === 0) return [];
    const needle = this.query.toLowerCase();
    const matches: number[] = [];
    for (const [index, line] of this.lines.entries()) {
      if (stripAnsi(line).toLowerCase().includes(needle)) matches.push(index);
    }
    return matches;
  }

  private jumpToMatch(direction: 1 | -1, rows: number): boolean {
    const matches = this.matchingLines();
    if (matches.length === 0) return this.query.length > 0;
    const ahead =
      direction === 1
        ? matches.find((line) => line > this.offset)
        : matches.filter((line) => line < this.offset).at(-1);
    const target = ahead ?? (direction === 1 ? matches[0] : matches.at(-1));
    if (target !== undefined) this.showLine(target, rows);
    return true;
  }

  private showLine(line: number, rows: number): void {
    this.pinnedToEnd = false;
    this.offset = clampOffset(line, this.lines.length, rows);
  }

  private scrollBy(lines: number, rows: number): boolean {
    this.pinnedToEnd = false;
    this.offset = clampOffset(this.offset + lines, this.lines.length, rows);
    return true;
  }

  private jumpTo(edge: "top" | "bottom", rows: number): boolean {
    this.pinnedToEnd = edge === "bottom";
    this.offset = edge === "bottom" ? clampOffset(this.lines.length, this.lines.length, rows) : 0;
    return true;
  }
}
