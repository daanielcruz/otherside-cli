import { stringWidth as cellWidth } from "@/terminal-runtime";

// The prompt content sits after a 2-cell prefix (chevron / continuation
// indent) and reserves room for the cursor cell at end of line.
const PROMPT_WRAP_MARGIN = 4;

export interface PromptDisplayRow {
  text: string;
  cursorOffset: number | null;
  cursorChar: string;
  // Display-width column of the cursor cell within the row; drives the
  // physical terminal cursor so wide graphemes before it don't skew it.
  cursorColumn: number | null;
  // Absolute offset of the row's first character in the display text; lets
  // renderers map a text range (e.g. the dimmed voice transcript) onto rows.
  start: number;
}

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

// Word boundaries come from Unicode word segmentation so CJK text (where
// each character is its own word) navigates correctly.
export function prevWordBoundary(text: string, pos: number): number {
  let lastStartBefore = 0;
  for (const segment of wordSegmenter.segment(text)) {
    if (!segment.isWordLike) continue;
    const start = segment.index;
    const end = start + segment.segment.length;
    if (start >= pos) break;
    // Inside a word (past its first character): its own start wins.
    if (pos > start && pos <= end) return start;
    lastStartBefore = start;
  }
  return lastStartBefore;
}

export function nextWordBoundary(text: string, pos: number): number {
  for (const segment of wordSegmenter.segment(text)) {
    if (segment.isWordLike && segment.index > pos) return segment.index;
  }
  return text.length;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function prevGraphemeBoundary(text: string, pos: number): number {
  if (pos <= 0) return 0;
  let boundary = 0;
  for (const { index } of graphemeSegmenter.segment(text.slice(0, pos))) {
    boundary = index;
  }
  return boundary;
}

export function nextGraphemeBoundary(text: string, pos: number): number {
  if (pos >= text.length) return text.length;
  for (const { segment } of graphemeSegmenter.segment(text.slice(pos))) {
    return pos + segment.length;
  }
  return text.length;
}

function graphemeStartAt(text: string, pos: number): number {
  if (pos <= 0) return 0;
  let start = 0;
  for (const { index } of graphemeSegmenter.segment(text)) {
    if (index > pos) break;
    start = index;
  }
  return start;
}

interface WrappedLine {
  text: string;
  start: number;
}

let wrapWalks = 0;

export function promptWrapWalkCount(): number {
  return wrapWalks;
}

// Single wrap walk owning both row text and row offsets. Wraps the real
// buffer text — the cursor is resolved against these offsets afterwards, so
// no marker character ever enters the wrap input. Width accumulates as the
// row grows (one cellWidth call per token/grapheme) so the walk stays linear
// in the text length.
function computeWrappedLines(text: string, width: number): WrappedLine[] {
  wrapWalks += 1;
  const out: WrappedLine[] = [];
  let absolute = 0;
  for (const rawLine of text.split("\n")) {
    let line = "";
    let lineWidth = 0;
    let lineStart = absolute;
    const flush = (): void => {
      out.push({ text: line, start: lineStart });
      lineStart += line.length;
      line = "";
      lineWidth = 0;
    };
    for (const token of splitPromptTokens(rawLine)) {
      const tokenWidth = cellWidth(token);
      if (lineWidth + tokenWidth > width && line.length > 0) flush();
      if (tokenWidth > width) {
        for (const { segment } of graphemeSegmenter.segment(token)) {
          const segmentWidth = cellWidth(segment);
          if (lineWidth + segmentWidth > width && line.length > 0) flush();
          line += segment;
          lineWidth += segmentWidth;
        }
      } else {
        line += token;
        lineWidth += tokenWidth;
      }
    }
    out.push({ text: line, start: lineStart });
    absolute += rawLine.length + 1;
  }
  return out;
}

function wrapLinesWithOffsets(text: string, width: number): WrappedLine[] {
  return computeWrappedLines(text, width);
}

export function promptWrapWidth(columns: number): number {
  return Math.max(1, columns - PROMPT_WRAP_MARGIN);
}

export function promptDisplayRows(
  text: string,
  cursor: number,
  columns: number,
): PromptDisplayRow[] {
  const clampedCursor = Math.max(0, Math.min(cursor, text.length));
  const safeCursor =
    clampedCursor < text.length ? graphemeStartAt(text, clampedCursor) : clampedCursor;
  const lines = wrapLinesWithOffsets(text, promptWrapWidth(columns));
  const cursorRow = rowIndexForOffset(lines, safeCursor);
  return lines.map((line, index) => {
    if (index !== cursorRow) {
      return {
        text: line.text.trimEnd(),
        cursorOffset: null,
        cursorChar: " ",
        cursorColumn: null,
        start: line.start,
      };
    }
    const offsetInRow = Math.max(0, Math.min(safeCursor - line.start, line.text.length));
    const grapheme =
      offsetInRow < line.text.length && text[safeCursor] !== "\n"
        ? line.text.slice(offsetInRow, nextGraphemeBoundary(line.text, offsetInRow))
        : " ";
    const before = line.text.slice(0, offsetInRow);
    const after =
      grapheme === " " && offsetInRow >= line.text.length
        ? ""
        : line.text.slice(offsetInRow + grapheme.length).trimEnd();
    return {
      text: before + grapheme + after,
      cursorOffset: offsetInRow,
      cursorChar: grapheme,
      cursorColumn: cellWidth(before),
      start: line.start,
    };
  });
}

// The cursor belongs to the first row that ends past it: an offset at a wrap
// boundary lands on the next row, while an offset on the newline ending a
// logical line stays on that row (its span reaches next.start - 1).
function rowIndexForOffset(lines: WrappedLine[], offset: number): number {
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1];
    if (next === undefined || offset < next.start) return i;
  }
  return lines.length - 1;
}

export interface LineEdit {
  text: string;
  cursor: number;
  killed: string;
}

// Start of the cursor's visual (wrapped) row. At column 0 of a row past the
// first, this climbs to the previous row's start so repeated presses walk up
// instead of sticking.
export function visualLineStartOffset(text: string, cursor: number, columns: number): number {
  const lines = wrapLinesWithOffsets(text, promptWrapWidth(columns));
  const row = rowIndexForOffset(lines, cursor);
  const start = lines[row]?.start ?? 0;
  if (cursor === start && row > 0) return lines[row - 1]?.start ?? 0;
  return start;
}

export function visualLineEndOffset(text: string, cursor: number, columns: number): number {
  const lines = wrapLinesWithOffsets(text, promptWrapWidth(columns));
  const row = rowIndexForOffset(lines, cursor);
  const line = lines[row];
  if (!line) return text.length;
  return Math.min(text.length, line.start + line.text.length);
}

export function logicalLineStartOffset(text: string, cursor: number): number {
  // A caret at the very start has no break behind it. The guard is load-bearing:
  // a negative search origin is clamped to 0, so text opening with a newline
  // would otherwise report that newline as its own predecessor.
  if (cursor <= 0) return 0;
  const prevNewline = text.lastIndexOf("\n", cursor - 1);
  return prevNewline === -1 ? 0 : prevNewline + 1;
}

export function logicalLineEndOffset(text: string, cursor: number): number {
  const nextNewline = text.indexOf("\n", cursor);
  return nextNewline === -1 ? text.length : nextNewline;
}

// Kill to the end of the visual row; on a newline it deletes just the
// newline, letting repeated presses eat forward across lines.
export function deleteToVisualLineEnd(text: string, cursor: number, columns: number): LineEdit {
  if (text[cursor] === "\n") {
    return { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor, killed: "\n" };
  }
  const end = visualLineEndOffset(text, cursor, columns);
  return {
    text: text.slice(0, cursor) + text.slice(end),
    cursor,
    killed: text.slice(cursor, end),
  };
}

// Kill to the start of the visual row; right after a newline it deletes just
// the newline, letting repeated presses clear backward across lines.
export function deleteToVisualLineStart(text: string, cursor: number, columns: number): LineEdit {
  if (cursor > 0 && text[cursor - 1] === "\n") {
    return {
      text: text.slice(0, cursor - 1) + text.slice(cursor),
      cursor: cursor - 1,
      killed: "\n",
    };
  }
  const start = visualLineStartOffset(text, cursor, columns);
  return {
    text: text.slice(0, start) + text.slice(cursor),
    cursor: start,
    killed: text.slice(start, cursor),
  };
}

export type RowSpanStyle = "plain" | "dim" | "match";

export interface RowSpan {
  text: string;
  style: RowSpanStyle;
}

export interface RowRange {
  start: number;
  end: number;
  style: Exclude<RowSpanStyle, "plain">;
}

// Split a row's text into spans against an absolute [start, end) range,
// styling the overlapping span. `rowStart` is the row's absolute offset.
export function splitRowByRange(text: string, rowStart: number, range: RowRange | null): RowSpan[] {
  if (!range) return [{ text, style: "plain" }];
  const from = Math.max(0, Math.min(text.length, range.start - rowStart));
  const to = Math.max(from, Math.min(text.length, range.end - rowStart));
  const spans: RowSpan[] = [];
  if (from > 0) spans.push({ text: text.slice(0, from), style: "plain" });
  if (to > from) spans.push({ text: text.slice(from, to), style: range.style });
  if (text.length > to) spans.push({ text: text.slice(to), style: "plain" });
  return spans.length > 0 ? spans : [{ text, style: "plain" }];
}

export function wrapPromptText(text: string, width: number): string[] {
  return wrapLinesWithOffsets(text, width).map((line) => line.text.trimEnd());
}

function splitPromptTokens(text: string): string[] {
  const matches = text.match(/\S+\s*|\s+/g);
  return matches && matches.length > 0 ? matches : [""];
}

export function cursorUpPosition(text: string, cursor: number, columns: number): number | null {
  return verticalCursorPosition(text, cursor, columns, -1);
}

export function cursorDownPosition(text: string, cursor: number, columns: number): number | null {
  return verticalCursorPosition(text, cursor, columns, 1);
}

function verticalCursorPosition(
  text: string,
  cursor: number,
  columns: number,
  direction: -1 | 1,
): number | null {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const lines = wrapLinesWithOffsets(text, promptWrapWidth(columns));
  const currentRow = rowIndexForOffset(lines, safeCursor);
  const targetRow = currentRow + direction;
  if (targetRow < 0 || targetRow >= lines.length) return null;
  const current = lines[currentRow];
  const target = lines[targetRow];
  if (!current || !target) return null;
  const column = cellWidth(current.text.slice(0, safeCursor - current.start));
  return target.start + offsetAtColumn(target.text, column);
}

// Walk the row's graphemes until the display column is reached; a column past
// the row's width lands at the row end (same-column preference, clamped).
function offsetAtColumn(text: string, column: number): number {
  let width = 0;
  for (const { segment, index } of graphemeSegmenter.segment(text)) {
    const next = width + cellWidth(segment);
    if (next > column) return index;
    width = next;
  }
  return text.length;
}

/**
 * What a vertical arrow does from here: move the caret a display row, or step out
 * of the draft into history because there is no row left to move to.
 *
 * The decision is the whole point — a draft tall enough to have rows keeps the
 * arrow, and only the topmost or bottommost row hands it over. Answering rather
 * than acting means the two directions share one walk instead of mirroring it.
 */
export type VerticalStep = { kind: "caret"; offset: number } | { kind: "history" };

export function verticalStep(
  direction: "up" | "down",
  text: string,
  caret: number,
  columns: number,
): VerticalStep {
  const target =
    direction === "up"
      ? cursorUpPosition(text, caret, columns)
      : cursorDownPosition(text, caret, columns);
  return target === null ? { kind: "history" } : { kind: "caret", offset: target };
}
