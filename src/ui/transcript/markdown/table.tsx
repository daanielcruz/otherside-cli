import type { Token, Tokens } from "marked";
import { Text, useTerminalDimensions } from "@/ink";
import { stripAnsi } from "@/kernel/std/ansi.ts";
import { stringWidth } from "@/kernel/std/text/string-width.ts";
import { Glyph } from "@/ui/theme/theme.ts";

const SAFETY_MARGIN = 4;
const MIN_COLUMN_WIDTH = 3;
const MAX_ROW_LINES = 4;
const EOL = "\n";
const ANSI_ESCAPE = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const BOLD_START = `${ANSI_ESCAPE}[1m`;
const BOLD_END = `${ANSI_ESCAPE}[22m`;

export interface MarkdownTableProps {
  token: Tokens.Table;
  formatCellTokens: (tokens: Token[] | undefined) => string;
  forceWidth?: number | undefined;
}

export function MarkdownTable({
  token,
  formatCellTokens,
  forceWidth,
}: MarkdownTableProps): React.JSX.Element {
  const { columns } = useTerminalDimensions();
  const terminalWidth = forceWidth ?? columns;
  const columnWidths = calculateColumnWidths(token, formatCellTokens, terminalWidth);
  const needsHardWrap = columnWidths.needsHardWrap;
  const widths = columnWidths.widths;
  const maxRowLines = calculateMaxRowLines(token, widths, needsHardWrap, formatCellTokens);
  const table =
    maxRowLines > MAX_ROW_LINES
      ? renderVerticalFormat(token, terminalWidth, formatCellTokens)
      : renderHorizontalFormat(token, widths, needsHardWrap, formatCellTokens);

  if (visibleWidthOfWidestLine(table) > terminalWidth - SAFETY_MARGIN) {
    return (
      <Text wrap="truncate-end">
        {renderVerticalFormat(token, terminalWidth, formatCellTokens)}
      </Text>
    );
  }
  return <Text wrap="truncate-end">{table}</Text>;
}

function calculateColumnWidths(
  token: Tokens.Table,
  formatCellTokens: (tokens: Token[] | undefined) => string,
  terminalWidth: number,
): { widths: number[]; needsHardWrap: boolean } {
  const minWidths = token.header.map((header, col) => {
    let maxWidth = minWidth(formatCellTokens(header.tokens));
    for (const row of token.rows) {
      maxWidth = Math.max(maxWidth, minWidth(formatCellTokens(row[col]?.tokens)));
    }
    return maxWidth;
  });
  const idealWidths = token.header.map((header, col) => {
    let maxWidth = idealWidth(formatCellTokens(header.tokens));
    for (const row of token.rows) {
      maxWidth = Math.max(maxWidth, idealWidth(formatCellTokens(row[col]?.tokens)));
    }
    return maxWidth;
  });
  const cols = token.header.length;
  const borderOverhead = 1 + cols * 3;
  const availableWidth = Math.max(
    terminalWidth - borderOverhead - SAFETY_MARGIN,
    cols * MIN_COLUMN_WIDTH,
  );
  const totalMin = sum(minWidths);
  const totalIdeal = sum(idealWidths);

  if (totalIdeal <= availableWidth) return { widths: idealWidths, needsHardWrap: false };
  if (totalMin <= availableWidth) {
    const extraSpace = availableWidth - totalMin;
    const overflows = idealWidths.map((ideal, i) => ideal - (minWidths[i] ?? MIN_COLUMN_WIDTH));
    const totalOverflow = sum(overflows);
    return {
      widths: minWidths.map((min, i) =>
        totalOverflow === 0
          ? min
          : min + Math.floor(((overflows[i] ?? 0) / totalOverflow) * extraSpace),
      ),
      needsHardWrap: false,
    };
  }

  const scale = availableWidth / totalMin;
  return {
    widths: minWidths.map((width) => Math.max(Math.floor(width * scale), MIN_COLUMN_WIDTH)),
    needsHardWrap: true,
  };
}

function calculateMaxRowLines(
  token: Tokens.Table,
  widths: number[],
  hard: boolean,
  formatCellTokens: (tokens: Token[] | undefined) => string,
): number {
  let maxLines = 1;
  for (let i = 0; i < token.header.length; i++) {
    maxLines = Math.max(
      maxLines,
      wrapCell(formatCellTokens(token.header[i]?.tokens), widths[i], hard).length,
    );
  }
  for (const row of token.rows) {
    for (let i = 0; i < row.length; i++) {
      maxLines = Math.max(
        maxLines,
        wrapCell(formatCellTokens(row[i]?.tokens), widths[i], hard).length,
      );
    }
  }
  return maxLines;
}

function renderHorizontalFormat(
  token: Tokens.Table,
  widths: number[],
  hard: boolean,
  formatCellTokens: (tokens: Token[] | undefined) => string,
): string {
  const lines: string[] = [];
  lines.push(renderBorder("top", widths));
  lines.push(...renderRow(token.header, widths, token.align, true, hard, formatCellTokens));
  lines.push(renderBorder("middle", widths));
  token.rows.forEach((row, index) => {
    lines.push(...renderRow(row, widths, token.align, false, hard, formatCellTokens));
    if (index < token.rows.length - 1) lines.push(renderBorder("middle", widths));
  });
  lines.push(renderBorder("bottom", widths));
  return lines.join(EOL);
}

function renderRow(
  cells: Array<{ tokens?: Token[] }>,
  widths: number[],
  align: Tokens.Table["align"],
  isHeader: boolean,
  hard: boolean,
  formatCellTokens: (tokens: Token[] | undefined) => string,
): string[] {
  const cellLines = cells.map((cell, col) =>
    wrapCell(formatCellTokens(cell.tokens), widths[col], hard),
  );
  const rowHeight = Math.max(...cellLines.map((lines) => lines.length), 1);
  const offsets = cellLines.map((lines) => Math.floor((rowHeight - lines.length) / 2));
  const out: string[] = [];

  for (let line = 0; line < rowHeight; line++) {
    let rendered = Glyph.boxPipe;
    for (let col = 0; col < cells.length; col++) {
      const lines = cellLines[col] ?? [""];
      const idx = line - (offsets[col] ?? 0);
      const text = idx >= 0 && idx < lines.length ? (lines[idx] ?? "") : "";
      rendered += ` ${padAligned(text, widths[col] ?? MIN_COLUMN_WIDTH, isHeader ? "center" : (align[col] ?? "left"))} ${Glyph.boxPipe}`;
    }
    out.push(rendered);
  }

  return out;
}

function renderBorder(type: "top" | "middle" | "bottom", widths: number[]): string {
  const parts =
    type === "top"
      ? ([Glyph.boxSharpTopLeft, Glyph.boxHLine, Glyph.boxTeeDown, Glyph.boxSharpTopRight] as const)
      : type === "middle"
        ? ([Glyph.boxLeftTee, Glyph.boxHLine, Glyph.boxCross, Glyph.boxRightTee] as const)
        : ([
            Glyph.boxSharpBottomLeft,
            Glyph.boxHLine,
            Glyph.boxTeeUp,
            Glyph.boxSharpBottomRight,
          ] as const);
  const [left, horizontal, cross, right] = parts;
  let line = left;
  widths.forEach((width, i) => {
    line += horizontal.repeat(width + 2);
    line += i < widths.length - 1 ? cross : right;
  });
  return line;
}

function renderVerticalFormat(
  token: Tokens.Table,
  terminalWidth: number,
  formatCellTokens: (tokens: Token[] | undefined) => string,
): string {
  const lines: string[] = [];
  const headers = token.header.map((header) => stripAnsi(formatCellTokens(header.tokens)).trim());
  const separator = Glyph.boxHLine.repeat(Math.min(Math.max(1, terminalWidth - 1), 40));
  const indent = "  ";

  token.rows.forEach((row, rowIndex) => {
    if (rowIndex > 0) lines.push(separator);
    row.forEach((cell, col) => {
      const label = headers[col] || `Column ${col + 1}`;
      const value = formatCellTokens(cell.tokens).replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
      const firstWidth = Math.max(10, terminalWidth - visibleWidth(label) - 3);
      const restWidth = Math.max(1, terminalWidth - indent.length - 1);
      const firstLines = wrapCell(value, firstWidth, false);
      const firstLine = firstLines[0] ?? "";
      const wrapped =
        firstLines.length <= 1 || restWidth <= firstWidth
          ? firstLines
          : [
              firstLine,
              ...wrapCell(
                firstLines
                  .slice(1)
                  .map((line) => line.trim())
                  .join(" "),
                restWidth,
                false,
              ),
            ];
      lines.push(`${BOLD_START}${label}:${BOLD_END} ${wrapped[0] ?? ""}`);
      for (const line of wrapped.slice(1)) {
        if (line.trim().length > 0) lines.push(`${indent}${line}`);
      }
    });
  });

  return lines.join(EOL);
}

function wrapCell(value: string, width: number | undefined, hard: boolean): string[] {
  const target = Math.max(1, width ?? MIN_COLUMN_WIDTH);
  const out: string[] = [];
  for (const line of value.trimEnd().split(EOL)) {
    if (line.length === 0) continue;
    out.push(...wrapLine(line, target, hard));
  }
  return out.length > 0 ? out : [""];
}

function wrapLine(line: string, width: number, hard: boolean): string[] {
  if (visibleWidth(line) <= width) return [line];
  const out: string[] = [];
  let current = "";
  for (const word of splitInclusive(line, " ")) {
    if (visibleWidth(current) + visibleWidth(word) > width && current.length > 0) {
      out.push(current.trimEnd());
      current = "";
    }
    if (visibleWidth(word) > width && hard) {
      const chunks = hardWrap(word, width);
      if (current.length > 0) {
        out.push(current.trimEnd());
        current = "";
      }
      out.push(...chunks.slice(0, -1));
      current = chunks.at(-1) ?? "";
    } else {
      current += word;
    }
  }
  if (current.length > 0) out.push(current.trimEnd());
  return out.length > 0 ? out : [line];
}

function hardWrap(text: string, width: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (let i = 0; i < text.length; ) {
    const ansi = readEscape(text, i);
    if (ansi !== null) {
      current += ansi.value;
      i = ansi.next;
      continue;
    }
    const ch = [...text.slice(i)][0] ?? "";
    const chWidth = visibleWidth(ch);
    if (currentWidth + chWidth > width && current.length > 0) {
      chunks.push(current);
      current = "";
      currentWidth = 0;
    }
    current += ch;
    currentWidth += chWidth;
    i += ch.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}

function splitInclusive(text: string, sep: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const ch of text) {
    buf += ch;
    if (ch === sep) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

function minWidth(value: string): number {
  const words = stripAnsi(value).split(/\s+/).filter(Boolean);
  if (words.length === 0) return MIN_COLUMN_WIDTH;
  return Math.max(...words.map(visibleWidth), MIN_COLUMN_WIDTH);
}

function idealWidth(value: string): number {
  return Math.max(visibleWidth(stripAnsi(value)), MIN_COLUMN_WIDTH);
}

function padAligned(
  value: string,
  width: number,
  align: "left" | "right" | "center" | null,
): string {
  const diff = Math.max(0, width - visibleWidth(value));
  if (align === "right") return `${" ".repeat(diff)}${value}`;
  if (align === "center") {
    const left = Math.floor(diff / 2);
    return `${" ".repeat(left)}${value}${" ".repeat(diff - left)}`;
  }
  return `${value}${" ".repeat(diff)}`;
}

function visibleWidth(value: string): number {
  return stringWidth(stripAnsi(value));
}

function visibleWidthOfWidestLine(value: string): number {
  return Math.max(...value.split(EOL).map(visibleWidth), 0);
}

function readEscape(text: string, index: number): { value: string; next: number } | null {
  if (text[index] !== ANSI_ESCAPE) return null;
  if (text[index + 1] === "[") {
    const end = text.indexOf("m", index + 2);
    if (end !== -1) return { value: text.slice(index, end + 1), next: end + 1 };
  }
  if (text[index + 1] === "]") {
    const belEnd = text.indexOf(BEL, index + 2);
    const stStart = text.indexOf(`${ANSI_ESCAPE}\\`, index + 2);
    const candidates: number[] = [];
    if (belEnd !== -1) candidates.push(belEnd);
    if (stStart !== -1) candidates.push(stStart + 1);
    if (candidates.length === 0) return null;
    const end = Math.min(...candidates);
    return { value: text.slice(index, end + 1), next: end + 1 };
  }
  return null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
