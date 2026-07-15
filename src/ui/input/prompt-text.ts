import { stringWidth as cellWidth } from "@/kernel/std/text/string-width.ts";
import { Glyph } from "@/ui/theme/theme.ts";

const CURSOR_MARK = "\uE000";

const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;
const PROMPT_RIGHT_PADDING = 5;

export interface PromptDisplayRow {
  text: string;
  cursorOffset: number | null;
  cursorChar: string;
}

export function prevWordBoundary(text: string, pos: number): number {
  let i = pos;
  while (i > 0 && !WORD_CHAR_RE.test(text[i - 1] ?? "")) i--;
  while (i > 0 && WORD_CHAR_RE.test(text[i - 1] ?? "")) i--;
  return i;
}

export function nextWordBoundary(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && !WORD_CHAR_RE.test(text[i] ?? "")) i++;
  while (i < text.length && WORD_CHAR_RE.test(text[i] ?? "")) i++;
  return i;
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

export function promptDisplayRows(
  text: string,
  cursor: number,
  columns: number,
): PromptDisplayRow[] {
  const clampedCursor = Math.max(0, Math.min(cursor, text.length));
  const safeCursor =
    clampedCursor < text.length ? graphemeStartAt(text, clampedCursor) : clampedCursor;
  const graphemeEnd =
    safeCursor < text.length ? nextGraphemeBoundary(text, safeCursor) : safeCursor;
  const cursorChar = safeCursor < text.length ? text.slice(safeCursor, graphemeEnd) : " ";
  const visible = text.slice(0, safeCursor) + CURSOR_MARK + text.slice(graphemeEnd);
  const firstWidth = promptContentWidth(columns, Glyph.chevron.length);
  const nextWidth = promptContentWidth(columns, 2);
  return wrapPromptText(visible, firstWidth, nextWidth).map((line) => {
    const cursorOffset = line.indexOf(CURSOR_MARK);
    if (cursorOffset < 0) return { text: line, cursorOffset: null, cursorChar };
    return {
      text: line.slice(0, cursorOffset) + cursorChar + line.slice(cursorOffset + 1),
      cursorOffset,
      cursorChar,
    };
  });
}

export function wrapPromptText(text: string, firstWidth: number, nextWidth: number): string[] {
  const out: string[] = [];
  let width = firstWidth;
  for (const rawLine of text.split("\n")) {
    let line = "";
    for (const token of splitPromptTokens(rawLine)) {
      if (cellWidth(line) + cellWidth(token) > width && line.length > 0) {
        out.push(line.trimEnd());
        line = "";
        width = nextWidth;
      }
      if (cellWidth(token) > width) {
        for (const ch of [...token]) {
          if (cellWidth(line) + cellWidth(ch) > width && line.length > 0) {
            out.push(line.trimEnd());
            line = "";
            width = nextWidth;
          }
          line += ch;
        }
      } else {
        line += token;
      }
    }
    out.push(line.trimEnd());
    width = nextWidth;
  }
  return out;
}

function promptContentWidth(columns: number, prefixWidth: number): number {
  return Math.max(1, columns - prefixWidth - PROMPT_RIGHT_PADDING);
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
  const rows = promptDisplayRows(text, safeCursor, columns);
  let currentRow = -1;
  let cursorColumn = 0;
  for (let i = 0; i < rows.length; i++) {
    const offset = rows[i]?.cursorOffset;
    if (offset !== null && offset !== undefined) {
      currentRow = i;
      cursorColumn = offset;
      break;
    }
  }
  if (currentRow < 0) return null;
  const targetRow = currentRow + direction;
  if (targetRow < 0 || targetRow >= rows.length) return null;

  const rowStarts = rowStartOffsets(text, columns);
  const targetStart = rowStarts[targetRow] ?? 0;
  const targetLength = rows[targetRow]?.text.length ?? 0;
  return Math.min(text.length, targetStart + Math.min(cursorColumn, targetLength));
}

function rowStartOffsets(text: string, columns: number): number[] {
  const firstWidth = promptContentWidth(columns, Glyph.chevron.length);
  const nextWidth = promptContentWidth(columns, 2);
  const starts: number[] = [];
  let width = firstWidth;
  let absolute = 0;
  for (const rawLine of text.split("\n")) {
    let line = "";
    let lineStart = absolute;
    for (const token of splitPromptTokens(rawLine)) {
      if (cellWidth(line) + cellWidth(token) > width && line.length > 0) {
        starts.push(lineStart);
        lineStart += line.length;
        line = "";
        width = nextWidth;
      }
      if (cellWidth(token) > width) {
        for (const ch of [...token]) {
          if (cellWidth(line) + cellWidth(ch) > width && line.length > 0) {
            starts.push(lineStart);
            lineStart += line.length;
            line = "";
            width = nextWidth;
          }
          line += ch;
        }
      } else {
        line += token;
      }
    }
    starts.push(lineStart);
    absolute += rawLine.length + 1;
    width = nextWidth;
  }
  return starts;
}
