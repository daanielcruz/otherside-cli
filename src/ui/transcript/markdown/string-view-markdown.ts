import { homedir } from "node:os";
import type { Token, Tokens } from "marked";
import { osc8FileLink, osc8UrlLink } from "@/terminal-runtime/terminal/hyperlink-sequences.js";
import { terminalAllowsLinks } from "@/terminal-runtime/terminal/link-policy.js";
import truncateAnsiString from "@/terminal-runtime/text/ansi-slice.js";
import { wrapProse } from "@/terminal-runtime/text/ansi-wrap.js";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { colorize, renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import type { TerminalTextStyle } from "@/terminal-runtime/text/style-model.js";
import { isSyntaxHighlightingEnabled } from "@/ui/theme/syntax-highlighting.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import { tokenize } from "@/ui/transcript/markdown/highlight.ts";
import { lexMarkdown } from "@/ui/transcript/markdown/lexer.ts";

const EOL = "\n";
const STRIPPED_PROMPT_TAGS =
  /<(commit_analysis|context|function_analysis|pr_analysis)>[\s\S]*?<\/\1>\n?/g;
const TABLE_SAFETY_MARGIN = 4;
const MIN_TABLE_COLUMN_WIDTH = 3;
const MAX_HORIZONTAL_CELL_LINES = 4;

export function renderMarkdownLines(source: string, width: number): string[] {
  if (source.trim().length === 0) return [];

  const content = source.replace(STRIPPED_PROMPT_TAGS, "").trim();
  if (content.length === 0) return [];

  const columns = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const groups: string[][] = [];
  let textBlocks = "";

  const flushTextBlocks = (): void => {
    const body = textBlocks.trim();
    if (body.length > 0) groups.push(wrapRows(body, columns));
    textBlocks = "";
  };

  for (const token of lexMarkdown(content)) {
    if (token.type === "table") {
      flushTextBlocks();
      groups.push(renderTable(token as Tokens.Table, columns));
    } else {
      textBlocks += formatToken(token, 0, null, null);
    }
  }
  flushTextBlocks();

  const rows: string[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    if (rows.length > 0) rows.push("");
    rows.push(...group);
  }
  return rows;
}

function wrapRows(text: string, width: number): string[] {
  return wrapProse(text, width);
}

function formatToken(
  token: Token,
  listDepth: number,
  orderedListNumber: number | null,
  parent: Token | null,
): string {
  switch (token.type) {
    case "blockquote": {
      const inner = ((token as Tokens.Blockquote).tokens ?? [])
        .map((child) => formatToken(child, 0, null, null))
        .join("");
      const bar = renderTextWithStyles(Glyph.blockQuarter, { dim: true });
      return inner
        .split(EOL)
        .map((line) =>
          stripAnsi(line).trim().length > 0
            ? `${bar} ${renderTextWithStyles(line, { italic: true })}`
            : line,
        )
        .join(EOL);
    }
    case "code": {
      const code = token as Tokens.Code;
      return `${highlightCode(code.text, code.lang)}${EOL}`;
    }
    case "codespan":
      return colorize((token as Tokens.Codespan).text, Color.inlineCode, "foreground");
    case "em": {
      const inner = ((token as Tokens.Em).tokens ?? [])
        .map((child) => formatToken(child, 0, null, parent))
        .join("");
      return renderTextWithStyles(inner, { italic: true });
    }
    case "strong": {
      const inner = ((token as Tokens.Strong).tokens ?? [])
        .map((child) => formatToken(child, 0, null, parent))
        .join("");
      return renderTextWithStyles(inner, { bold: true });
    }
    case "del": {
      const inner = ((token as Tokens.Del).tokens ?? [])
        .map((child) => formatToken(child, 0, null, parent))
        .join("");
      return renderTextWithStyles(inner, { strikethrough: true });
    }
    case "heading": {
      const heading = token as Tokens.Heading;
      const inner = (heading.tokens ?? [])
        .map((child) => formatToken(child, 0, null, null))
        .join("");
      const styles: TerminalTextStyle =
        heading.depth === 1 ? { bold: true, italic: true, underline: true } : { bold: true };
      return `${renderTextWithStyles(inner, styles)}${EOL}${EOL}`;
    }
    case "hr":
      return "---";
    case "image":
      return (token as Tokens.Image).href;
    case "link": {
      const link = token as Tokens.Link;
      if (link.href.startsWith("mailto:")) return link.href.replace(/^mailto:/, "");
      const label = (link.tokens ?? []).map((child) => formatToken(child, 0, null, link)).join("");
      const display = stripAnsi(label);
      return formatHyperlink(
        link.href,
        display.length > 0 && display !== link.href ? label : link.href,
      );
    }
    case "list": {
      const list = token as Tokens.List;
      return list.items
        .map((item, index) =>
          formatToken(item, listDepth, list.ordered ? Number(list.start) + index : null, list),
        )
        .join("");
    }
    case "list_item": {
      const item = token as Tokens.ListItem;
      return (item.tokens ?? [])
        .map(
          (child) =>
            `${"  ".repeat(listDepth)}${formatToken(
              child,
              listDepth + 1,
              orderedListNumber,
              item,
            )}`,
        )
        .join("");
    }
    case "paragraph": {
      const paragraph = token as Tokens.Paragraph;
      return `${(paragraph.tokens ?? [])
        .map((child) => formatToken(child, 0, null, null))
        .join("")}${EOL}`;
    }
    case "space":
    case "br":
      return EOL;
    case "text": {
      const text = token as Tokens.Text;
      if (parent?.type === "link") return text.text;
      if (parent?.type === "list_item") {
        const marker =
          orderedListNumber === null ? "-" : `${formatListNumber(listDepth, orderedListNumber)}.`;
        const inner =
          (text.tokens ?? []).length > 0
            ? (text.tokens ?? [])
                .map((child) => formatToken(child, listDepth, orderedListNumber, text))
                .join("")
            : text.text;
        return `${marker} ${inner}${EOL}`;
      }
      return (text.tokens ?? []).length > 0
        ? (text.tokens ?? []).map((child) => formatToken(child, 0, null, text)).join("")
        : text.text;
    }
    case "escape":
      return (token as Tokens.Escape).text;
    case "html":
    case "def":
      return "";
    default:
      return "";
  }
}

function formatHyperlink(url: string, label: string): string {
  if (!terminalAllowsLinks()) {
    const plain = stripAnsi(label);
    if (plain !== url && url !== `http://${plain}` && url !== `https://${plain}`) {
      return `${label} (${url})`;
    }
    return url;
  }

  const localPath = url.startsWith("~/")
    ? `${homedir()}/${url.slice(2)}`
    : url.startsWith("/")
      ? url
      : null;
  const linked = localPath ? osc8FileLink({ path: localPath, label }) : osc8UrlLink({ url, label });
  return renderTextWithStyles(linked, { color: "ansi:blueBright" });
}

function formatListNumber(depth: number, value: number): string {
  if (depth <= 1) return String(value);
  if (depth === 2) return numberToLetters(value);
  if (depth === 3) return numberToRoman(value);
  return String(value);
}

function numberToLetters(value: number): string {
  let result = "";
  let remaining = value;
  while (remaining > 0) {
    remaining--;
    result = String.fromCharCode(97 + (remaining % 26)) + result;
    remaining = Math.floor(remaining / 26);
  }
  return result;
}

const ROMAN_VALUES: ReadonlyArray<readonly [number, string]> = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

function numberToRoman(value: number): string {
  let result = "";
  let remaining = value;
  for (const [amount, numeral] of ROMAN_VALUES) {
    while (remaining >= amount) {
      result += numeral;
      remaining -= amount;
    }
  }
  return result;
}

const HIGHLIGHT_STYLES: Record<string, TerminalTextStyle> = {
  keyword: { color: Color.syntaxKeyword },
  built_in: { color: Color.syntaxType },
  type: { color: Color.syntaxType, dim: true },
  literal: { color: Color.syntaxKeyword },
  number: { color: Color.syntaxNumber },
  regexp: { color: Color.syntaxString },
  string: { color: Color.syntaxString },
  class: { color: Color.syntaxKeyword },
  function: { color: Color.syntaxTitle },
  comment: { color: Color.syntaxNumber },
  doctag: { color: Color.syntaxNumber },
  meta: { color: "ansi:blackBright" },
  tag: { color: "ansi:blackBright" },
  name: { color: Color.syntaxKeyword },
  attr: { color: Color.syntaxType },
  emphasis: { italic: true },
  strong: { bold: true },
  link: { underline: true },
  addition: { color: Color.syntaxNumber },
  deletion: { color: Color.syntaxString },
};

function highlightCode(text: string, languageName: string | undefined): string {
  if (!isSyntaxHighlightingEnabled()) return text;
  const language = languageName?.trim().toLowerCase() || null;
  if (language === null) return text;
  const spans = tokenize(text, language);
  if (spans.length <= 1 && !spans[0]?.scope) return text;
  return spans
    .map((span) => {
      const scope = span.scope?.split(".")[0];
      const styles = scope ? HIGHLIGHT_STYLES[scope] : undefined;
      return styles ? renderTextWithStyles(span.text, styles) : span.text;
    })
    .join("");
}

function formatCellTokens(tokens: Token[] | undefined): string {
  return tokens?.map((token) => formatToken(token, 0, null, null)).join("") ?? "";
}

function renderTable(token: Tokens.Table, terminalWidth: number): string[] {
  if (token.header.length === 0) return [];

  const { widths, needsHardWrap } = calculateColumnWidths(token, terminalWidth);
  const maxCellLines = calculateMaxCellLines(token, widths, needsHardWrap);
  const horizontal =
    maxCellLines <= MAX_HORIZONTAL_CELL_LINES
      ? renderHorizontalTable(token, widths, needsHardWrap)
      : [];
  const rows =
    horizontal.length > 0 && widestRow(horizontal) <= terminalWidth - TABLE_SAFETY_MARGIN
      ? horizontal
      : renderVerticalTable(token, terminalWidth);

  return rows.map((row) =>
    stringWidth(row) > terminalWidth ? truncateAnsiString(row, 0, terminalWidth) : row,
  );
}

function calculateColumnWidths(
  token: Tokens.Table,
  terminalWidth: number,
): { widths: number[]; needsHardWrap: boolean } {
  const minimums = token.header.map((header, column) => {
    let width = minimumCellWidth(formatCellTokens(header.tokens));
    for (const row of token.rows) {
      width = Math.max(width, minimumCellWidth(formatCellTokens(row[column]?.tokens)));
    }
    return width;
  });
  const ideals = token.header.map((header, column) => {
    let width = idealCellWidth(formatCellTokens(header.tokens));
    for (const row of token.rows) {
      width = Math.max(width, idealCellWidth(formatCellTokens(row[column]?.tokens)));
    }
    return width;
  });
  const columnCount = token.header.length;
  const borderOverhead = 1 + columnCount * 3;
  const available = Math.max(
    terminalWidth - borderOverhead - TABLE_SAFETY_MARGIN,
    columnCount * MIN_TABLE_COLUMN_WIDTH,
  );
  const minimumTotal = sum(minimums);
  const idealTotal = sum(ideals);

  if (idealTotal <= available) return { widths: ideals, needsHardWrap: false };
  if (minimumTotal <= available) {
    const extra = available - minimumTotal;
    const overflows = ideals.map(
      (ideal, index) => ideal - (minimums[index] ?? MIN_TABLE_COLUMN_WIDTH),
    );
    const overflowTotal = sum(overflows);
    return {
      widths: minimums.map((minimum, index) =>
        overflowTotal === 0
          ? minimum
          : minimum + Math.floor(((overflows[index] ?? 0) / overflowTotal) * extra),
      ),
      needsHardWrap: false,
    };
  }

  const scale = available / minimumTotal;
  return {
    widths: minimums.map((minimum) =>
      Math.max(Math.floor(minimum * scale), MIN_TABLE_COLUMN_WIDTH),
    ),
    needsHardWrap: true,
  };
}

function calculateMaxCellLines(token: Tokens.Table, widths: number[], hardWrap: boolean): number {
  let maximum = 1;
  for (let column = 0; column < token.header.length; column++) {
    maximum = Math.max(
      maximum,
      wrapTableCell(formatCellTokens(token.header[column]?.tokens), widths[column], hardWrap)
        .length,
    );
  }
  for (const row of token.rows) {
    for (let column = 0; column < row.length; column++) {
      maximum = Math.max(
        maximum,
        wrapTableCell(formatCellTokens(row[column]?.tokens), widths[column], hardWrap).length,
      );
    }
  }
  return maximum;
}

/** A table written with no column titles at all: every header cell is blank. */
function hasNamedColumns(header: Tokens.Table["header"]): boolean {
  return header.some((cell) => stripAnsi(formatCellTokens(cell.tokens)).trim().length > 0);
}

function renderHorizontalTable(token: Tokens.Table, widths: number[], hardWrap: boolean): string[] {
  const rows: string[] = [renderTableBorder("top", widths)];
  // A blank header band reads as a broken first row, so an unnamed table opens
  // straight into its data.
  if (hasNamedColumns(token.header)) {
    rows.push(...renderTableRow(token.header, widths, token.align, true, hardWrap));
    rows.push(renderTableBorder("middle", widths));
  }
  token.rows.forEach((row, index) => {
    rows.push(...renderTableRow(row, widths, token.align, false, hardWrap));
    if (index < token.rows.length - 1) rows.push(renderTableBorder("middle", widths));
  });
  rows.push(renderTableBorder("bottom", widths));
  return rows;
}

function renderTableRow(
  cells: Array<{ tokens?: Token[] }>,
  widths: number[],
  alignment: Tokens.Table["align"],
  header: boolean,
  hardWrap: boolean,
): string[] {
  const cellRows = cells.map((cell, column) =>
    wrapTableCell(formatCellTokens(cell.tokens), widths[column], hardWrap),
  );
  const rowHeight = Math.max(...cellRows.map((rows) => rows.length), 1);
  const offsets = cellRows.map((rows) => Math.floor((rowHeight - rows.length) / 2));
  const output: string[] = [];

  for (let line = 0; line < rowHeight; line++) {
    let rendered = Glyph.boxPipe;
    for (let column = 0; column < cells.length; column++) {
      const rows = cellRows[column] ?? [""];
      const rowIndex = line - (offsets[column] ?? 0);
      const text = rowIndex >= 0 && rowIndex < rows.length ? (rows[rowIndex] ?? "") : "";
      const align = header ? "center" : (alignment[column] ?? "left");
      rendered += ` ${padAligned(text, widths[column] ?? MIN_TABLE_COLUMN_WIDTH, align)} ${Glyph.boxPipe}`;
    }
    output.push(rendered);
  }
  return output;
}

function renderTableBorder(kind: "top" | "middle" | "bottom", widths: number[]): string {
  const glyphs =
    kind === "top"
      ? ([Glyph.boxSharpTopLeft, Glyph.boxHLine, Glyph.boxTeeDown, Glyph.boxSharpTopRight] as const)
      : kind === "middle"
        ? ([Glyph.boxLeftTee, Glyph.boxHLine, Glyph.boxCross, Glyph.boxRightTee] as const)
        : ([
            Glyph.boxSharpBottomLeft,
            Glyph.boxHLine,
            Glyph.boxTeeUp,
            Glyph.boxSharpBottomRight,
          ] as const);
  const [left, horizontal, cross, right] = glyphs;
  let row = left;
  widths.forEach((width, index) => {
    row += horizontal.repeat(width + 2);
    row += index < widths.length - 1 ? cross : right;
  });
  return row;
}

function renderVerticalTable(token: Tokens.Table, terminalWidth: number): string[] {
  const rows: string[] = [];
  const headers = token.header.map((header) => stripAnsi(formatCellTokens(header.tokens)).trim());
  const separator = Glyph.boxHLine.repeat(Math.min(Math.max(1, terminalWidth - 1), 40));
  const indent = "  ";

  token.rows.forEach((row, rowIndex) => {
    if (rowIndex > 0) rows.push(separator);
    row.forEach((cell, column) => {
      const label = headers[column] || `Column ${column + 1}`;
      const value = formatCellTokens(cell.tokens).replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
      const firstWidth = Math.max(10, terminalWidth - visibleWidth(label) - 3);
      const restWidth = Math.max(1, terminalWidth - indent.length - 1);
      const firstRows = wrapTableCell(value, firstWidth, false);
      const wrapped =
        firstRows.length <= 1 || restWidth <= firstWidth
          ? firstRows
          : [
              firstRows[0] ?? "",
              ...wrapTableCell(
                firstRows
                  .slice(1)
                  .map((line) => line.trim())
                  .join(" "),
                restWidth,
                false,
              ),
            ];
      rows.push(`${renderTextWithStyles(`${label}:`, { bold: true })} ${wrapped[0] ?? ""}`);
      for (const line of wrapped.slice(1)) {
        if (line.trim().length > 0) rows.push(`${indent}${line}`);
      }
    });
  });
  return rows;
}

function wrapTableCell(value: string, width: number | undefined, hardWrap: boolean): string[] {
  const target = Math.max(1, width ?? MIN_TABLE_COLUMN_WIDTH);
  const rows: string[] = [];
  for (const line of value.trimEnd().split(EOL)) {
    if (line.length === 0) continue;
    rows.push(...wrapProse(line, target, { hard: hardWrap }));
  }
  return rows.length > 0 ? rows : [""];
}

function minimumCellWidth(value: string): number {
  const words = stripAnsi(value).split(/\s+/).filter(Boolean);
  if (words.length === 0) return MIN_TABLE_COLUMN_WIDTH;
  return Math.max(...words.map(visibleWidth), MIN_TABLE_COLUMN_WIDTH);
}

function idealCellWidth(value: string): number {
  return Math.max(visibleWidth(stripAnsi(value)), MIN_TABLE_COLUMN_WIDTH);
}

function padAligned(
  value: string,
  width: number,
  alignment: "left" | "right" | "center" | null,
): string {
  const difference = Math.max(0, width - visibleWidth(value));
  if (alignment === "right") return `${" ".repeat(difference)}${value}`;
  if (alignment === "center") {
    const left = Math.floor(difference / 2);
    return `${" ".repeat(left)}${value}${" ".repeat(difference - left)}`;
  }
  return `${value}${" ".repeat(difference)}`;
}

function visibleWidth(value: string): number {
  return stringWidth(stripAnsi(value));
}

function widestRow(rows: string[]): number {
  return Math.max(...rows.map(visibleWidth), 0);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
