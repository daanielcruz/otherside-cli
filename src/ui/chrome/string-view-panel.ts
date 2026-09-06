import { computeListWindow } from "@/kernel/std/list-window.ts";
import { clamp } from "@/kernel/std/math.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import { cellClip } from "@/terminal-runtime/text/cell-clip.ts";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import type { TerminalColor } from "@/terminal-runtime/text/style-model.js";
import {
  type PanelHeader,
  panelCommandBarLine,
  panelHasTabs,
  panelTitleRowLine,
} from "@/ui/chrome/panel-header.ts";
import { HINT_JOINER } from "@/ui/chrome/panel-hints.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

/**
 * Pure line builders for the string-view footer panels. Each returns the exact
 * `string[]` a panel occupies in the inline flow, so a panel replaces the footer
 * without absolute compositing. Styling flows through `renderTextWithStyles`; the
 * geometry (marker gutter, label column, tab chips, search frame, list window)
 * mirrors the shared panel surface so every ported panel shares one layout law.
 */

const CONTENT_PAD_X = 2;
const ROW_LABEL_WIDTH = 34;
/** Columns between the widest label of a list and the value column it sets. */
const LABEL_COLUMN_GAP = 4;
const PICKER_ROWS = 3;
const WINDOW_MIN_ROWS = 3;
const STRING_VIEW_SHELL_ROWS = 7;
/** Row count to assume for a terminal that does not report its own. */
export const FALLBACK_TERMINAL_ROWS = 24;
/** Column count to assume before the first frame has been drawn at a real width. */
export const FALLBACK_TERMINAL_COLUMNS = 80;
const WINDOW_OVERFLOW_INDICATOR_ROWS = 2;

/** The inset every panel's content sits at; a composed frame aligns to it. */
export const CONTENT_INDENT = " ".repeat(CONTENT_PAD_X);

/**
 * Columns a panel's body has at a frame of `width`. A caller composing lines of
 * its own asks here rather than restating the inset, so a body built outside the
 * builder still ends where the rows inside it do.
 */
export function panelContentWidth(width: number): number {
  return Math.max(1, Math.floor(width) - CONTENT_PAD_X * 2);
}

export interface PanelSearch {
  query: string;
  placeholder: string;
  focused: boolean;
  /** Caret position in code points; absent means end-of-query. */
  cursorOffset?: number;
}

export interface PanelRowSpec {
  label: string;
  /**
   * Pre-styled display for the label column, placed verbatim (e.g. a multi-color
   * row where one label color cannot express it). `label` stays the plain text used
   * for the column width math.
   */
  styledLabel?: string | undefined;
  labelSuffix?: string | undefined;
  labelSuffixWidth?: number | undefined;
  value?: string | undefined;
  description?: string | undefined;
  descriptionPlacement?: "after-value" | "after-label" | undefined;
  selected?: boolean | undefined;
  active?: boolean | undefined;
  muted?: boolean | undefined;
  valueColor?: TerminalColor | undefined;
}

export interface PanelPickerRowSpec {
  label: string;
  /** Trailing detail rendered dim after the label — origin, tags, counts. */
  labelMeta?: string | undefined;
  description?: string | undefined;
  /** Columns the description row is inset; 2 aligns under the marker gutter. */
  descriptionIndent?: number | undefined;
  selected?: boolean | undefined;
  marker?: string | undefined;
  /** Overrides the label hue where the row's own state outranks the cursor (e.g. installed). */
  labelColor?: TerminalColor | undefined;
  labelBold?: boolean | undefined;
  labelItalic?: boolean | undefined;
  rows?: number | undefined;
}

export interface FooterPanelSpec extends PanelHeader {
  command?: string | undefined;
  subtitle?: string | undefined;
  subtitleSuffix?: string | undefined;
  search?: PanelSearch | undefined;
  searchMarginTop?: number | undefined;
  searchMarginBottom?: number | undefined;
  footerHints?: [string, string][] | undefined;
  footerPaddingX?: number | undefined;
  footerMarginTop?: number | undefined;
  inputGuide?: string | undefined;
  accent?: TerminalColor | undefined;
  titleColor?: TerminalColor | undefined;
  flushTop?: boolean | undefined;
  /**
   * Rows the panel may occupy. A body longer than the frame allows is clipped with an
   * overflow marker; without it, a long body pushes the frame off screen and the rows
   * that scroll past leave fragments behind.
   */
  maxRows?: number | undefined;
  /**
   * True when the panel holds the whole frame, so no prompt or status sits below it
   * and the rows normally reserved for them are the panel's to use.
   */
  fullscreen?: boolean | undefined;
  body: string[];
}

export interface ListPanelSpec {
  command?: string | undefined;
  title: string;
  subtitle?: string | undefined;
  items: (PanelRowSpec & { id: string })[];
  cursor: number;
  maxRows: number;
  search?: PanelSearch | undefined;
  footerHints?: [string, string][] | undefined;
  rowWidth?: number | undefined;
  emptyLabel?: string | undefined;
  /**
   * Lines drawn under the rows and above the footer, for a list that carries a
   * fixed panel of its own below itself. They are counted against the frame, so
   * the row window shrinks by what they take instead of pushing the footer off.
   */
  bodySuffix?: readonly string[] | undefined;
}

export function renderFooterPanel(spec: FooterPanelSpec, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const hue = spec.accent ?? Color.panelAccent;
  const headlineColor = spec.titleColor ?? hue;
  const lines: string[] = [];

  if (spec.command !== undefined) {
    lines.push(panelCommandBarLine(spec.command, w));
    lines.push("");
  }

  lines.push(renderTextWithStyles(Glyph.boxHLine.repeat(w), { color: hue }));

  if (spec.title !== undefined || panelHasTabs(spec)) {
    lines.push(panelTitleRowLine(spec, headlineColor, CONTENT_INDENT));
  }

  if (spec.subtitle) {
    lines.push("");
    lines.push(
      CONTENT_INDENT +
        renderTextWithStyles(spec.subtitle, { bold: true }) +
        (spec.subtitleSuffix === undefined
          ? ""
          : renderTextWithStyles(spec.subtitleSuffix, { color: Color.muted })),
    );
  }

  if (spec.search !== undefined) {
    for (let row = 0; row < (spec.searchMarginTop ?? 0); row++) lines.push("");
    for (const line of searchBoxLines(spec.search, w)) lines.push(line);
    for (let row = 0; row < (spec.searchMarginBottom ?? 1); row++) lines.push("");
  }

  const contentMargin = contentMarginRows(spec);
  for (let row = 0; row < contentMargin; row++) lines.push("");
  for (const line of fittedBody(spec, contentMargin, w)) lines.push(CONTENT_INDENT + line);

  if (spec.inputGuide) {
    lines.push("");
    lines.push(
      CONTENT_INDENT +
        renderTextWithStyles(truncateEllipsis(spec.inputGuide, w - CONTENT_PAD_X * 2), {
          color: Color.muted,
          italic: true,
        }),
    );
  }

  if (spec.footerHints && spec.footerHints.length > 0) {
    const marginTop = spec.footerMarginTop ?? 1;
    for (let row = 0; row < marginTop; row++) lines.push("");
    lines.push(...footerHintsLines(spec.footerHints, spec.footerPaddingX ?? CONTENT_PAD_X, w));
  }

  lines.push("");
  // Row-width law: a row wider than the frame breaks physically in the terminal
  // and desynchronizes the writer's row accounting, ghosting neighbouring rows.
  return lines.map((line) => cellClip(line, w));
}

/** Rows the frame spends on everything that is not body, at the width it draws. */
function footerPanelChromeRows(
  spec: FooterPanelSpec,
  contentMargin: number,
  width: number,
): number {
  let rows = 1 + contentMargin + 1;
  if (spec.command !== undefined) rows += 2;
  if (spec.title !== undefined || panelHasTabs(spec)) rows += 1;
  if (spec.subtitle) rows += 2;
  if (spec.search !== undefined) {
    rows += 3 + (spec.searchMarginTop ?? 0) + (spec.searchMarginBottom ?? 1);
  }
  if (spec.inputGuide) rows += 2;
  if (spec.footerHints && spec.footerHints.length > 0) {
    // Hints wrap rather than clip, so how many rows they take is a question about
    // the width. Counting them as one would spend rows the frame does not have.
    rows +=
      (spec.footerMarginTop ?? 1) +
      footerHintsLines(spec.footerHints, spec.footerPaddingX ?? CONTENT_PAD_X, width).length;
  }
  return rows;
}

function contentMarginRows(spec: FooterPanelSpec): number {
  if (spec.search !== undefined) return 0;
  if (spec.subtitle) return 1;
  return spec.flushTop ? 0 : 1;
}

/**
 * Body rows a panel of this shape may occupy in a terminal of `terminalRows`, drawn
 * at `width`. A panel that windows its own body — a card scrolled with its own keys
 * — has to know the budget before it slices, and deriving it here keeps that number
 * tied to the chrome it comes from instead of being restated at the call site.
 *
 * The width is not optional: hints wrap, so the same panel spends more chrome on a
 * narrow terminal, and a caller that windowed without it would slice to a budget the
 * frame no longer has.
 */
export function footerPanelBodyBudget(
  spec: FooterPanelSpec,
  terminalRows: number,
  width: number,
): number {
  const chrome = footerPanelChromeRows(spec, contentMarginRows(spec), width);
  return Math.max(1, Math.floor(terminalRows) - chrome - shellReserveRows(spec));
}

/** Rows the shell keeps below a footer panel; one holding the frame gives them back. */
function shellReserveRows(spec: FooterPanelSpec): number {
  return spec.fullscreen === true ? 0 : STRING_VIEW_SHELL_ROWS;
}

function fittedBody(
  spec: FooterPanelSpec,
  contentMargin: number,
  width: number,
): readonly string[] {
  if (spec.maxRows === undefined) return spec.body;
  const budget =
    spec.maxRows - footerPanelChromeRows(spec, contentMargin, width) - shellReserveRows(spec);
  if (budget >= spec.body.length) return spec.body;
  const visible = spec.body.slice(0, Math.max(1, budget - 1));
  return [...visible, listOverflowLine("down", spec.body.length - visible.length, undefined)];
}

function listPanelChromeRows(spec: ListPanelSpec): number {
  let rows = 1 + 1 + 1;
  if (spec.command !== undefined) rows += 2;
  if (spec.subtitle) rows += 2;
  rows += spec.search === undefined ? 1 : 4;
  if (spec.footerHints && spec.footerHints.length > 0) rows += 2;
  return rows + (spec.bodySuffix?.length ?? 0);
}

/**
 * Rows a list panel of this shape shows at once. A panel that pages its own cursor
 * asks here for the step, so the page a key moves is the page the frame draws.
 */
export function listPanelPageSize(spec: ListPanelSpec): number {
  return clamp(
    spec.maxRows - listPanelChromeRows(spec) - STRING_VIEW_SHELL_ROWS,
    WINDOW_MIN_ROWS,
    Math.max(WINDOW_MIN_ROWS, spec.items.length),
  );
}

export function renderListPanel(spec: ListPanelSpec, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const contentWidth = panelContentWidth(w);
  const cursor = Math.min(spec.cursor, Math.max(0, spec.items.length - 1));

  const size = clamp(
    spec.maxRows - listPanelChromeRows(spec) - STRING_VIEW_SHELL_ROWS,
    WINDOW_MIN_ROWS,
    spec.items.length,
  );
  const overflow = spec.items.length > size;
  const windowSize = overflow ? Math.max(1, size - WINDOW_OVERFLOW_INDICATOR_ROWS) : size;
  const window = computeListWindow({
    cursor,
    total: spec.items.length,
    size: windowSize,
    anchor: "bottom",
  });
  const visible = spec.items.slice(window.from, window.to);

  const body: string[] = [];
  if (spec.items.length === 0) {
    body.push(renderTextWithStyles(spec.emptyLabel ?? "No items found.", { color: Color.muted }));
  } else {
    if (overflow) {
      body.push(
        window.above > 0 ? listOverflowLine("up", window.above, "above", CONTENT_PAD_X) : "",
      );
    }
    for (let index = 0; index < visible.length; index++) {
      const item = visible[index]!;
      body.push(
        renderPanelRowLine(
          { ...item, selected: window.from + index === cursor },
          contentWidth,
          spec.rowWidth ?? ROW_LABEL_WIDTH,
        ),
      );
    }
    if (overflow) {
      body.push(
        window.below > 0 ? listOverflowLine("down", window.below, "below", CONTENT_PAD_X) : "",
      );
    }
  }

  if (spec.bodySuffix !== undefined) body.push(...spec.bodySuffix);

  const footerSpec: FooterPanelSpec = { title: spec.title, body };
  if (spec.command !== undefined) footerSpec.command = spec.command;
  if (spec.subtitle !== undefined) footerSpec.subtitle = spec.subtitle;
  if (spec.search !== undefined) footerSpec.search = spec.search;
  if (spec.footerHints !== undefined) footerSpec.footerHints = spec.footerHints;
  return renderFooterPanel(footerSpec, w);
}

/**
 * The column a list's values start at: the widest label it holds plus a gap.
 *
 * A list sized to its own content sits tight when the labels are short, and no
 * label can push its value past the column the rows above it established — which
 * is what a fixed width lets a long one do.
 */
export function labelColumnWidth(labels: readonly string[], gap = LABEL_COLUMN_GAP): number {
  let widest = 0;
  for (const label of labels) widest = Math.max(widest, stringWidth(label));
  return widest + gap;
}

export function renderPanelRowLine(
  spec: PanelRowSpec,
  contentWidth: number,
  columnWidth = ROW_LABEL_WIDTH,
): string {
  const {
    label,
    styledLabel,
    labelSuffix = "",
    labelSuffixWidth = stringWidth(labelSuffix),
    value,
    description,
    descriptionPlacement = "after-value",
    selected = false,
    active = false,
    muted = false,
    valueColor,
  } = spec;

  const markerColor = active ? Color.success : selected ? Color.panelAccent : Color.muted;
  const labelColor = muted ? Color.muted : selected ? Color.panelAccent : Color.text;
  const marker = renderTextWithStyles(selected || active ? Glyph.chevron : "  ", {
    color: markerColor,
  });

  const labelLen = stringWidth(label);
  const descriptionText = description === undefined ? undefined : ` (${description})`;
  const inlineDescription = descriptionPlacement === "after-label" && descriptionText !== undefined;

  let column =
    (styledLabel ?? renderTextWithStyles(label, { color: labelColor, bold: selected })) +
    labelSuffix;
  if (inlineDescription) {
    const descriptionWidth = Math.max(0, columnWidth - labelLen - labelSuffixWidth);
    column += renderTextWithStyles(truncateEllipsis(descriptionText ?? "", descriptionWidth), {
      color: Color.subtle,
    });
  } else {
    const pad =
      value !== undefined
        ? Math.max(1, columnWidth - labelLen - labelSuffixWidth)
        : Math.max(0, columnWidth - labelLen - labelSuffixWidth);
    column += " ".repeat(pad);
  }

  let line = marker + column;
  const remaining = Math.max(0, contentWidth - stringWidth(line));

  if (value !== undefined) {
    const valueText = truncateEllipsis(value, remaining);
    line += renderTextWithStyles(valueText, {
      color: valueColor ?? (muted ? Color.muted : Color.text),
    });
  }

  if (!inlineDescription && descriptionText !== undefined) {
    const descRemaining = Math.max(0, contentWidth - stringWidth(line));
    line += renderTextWithStyles(truncateEllipsis(descriptionText, descRemaining), {
      color: Color.muted,
    });
  }

  return line;
}

export function renderPanelPickerRowLines(spec: PanelPickerRowSpec, width: number): string[] {
  const rows = spec.rows ?? PICKER_ROWS;
  const selected = spec.selected ?? false;
  const marker = spec.marker ?? (selected ? Glyph.chevron : "  ");
  const labelColor = spec.labelColor ?? (selected ? Color.panelAccent : Color.text);

  const budget = Math.max(0, width - stringWidth(marker));
  const label = truncateEllipsis(spec.label, budget);
  const meta =
    spec.labelMeta === undefined
      ? ""
      : renderTextWithStyles(
          truncateEllipsis(spec.labelMeta, Math.max(0, budget - stringWidth(label))),
          { color: Color.muted },
        );
  const head =
    renderTextWithStyles(marker, { color: selected ? Color.panelAccent : Color.muted }) +
    renderTextWithStyles(label, {
      color: labelColor,
      bold: spec.labelBold ?? selected,
      italic: spec.labelItalic ?? false,
    }) +
    meta;

  const lines = [head];
  if (spec.description !== undefined) {
    const indent = spec.descriptionIndent ?? 2;
    lines.push(
      " ".repeat(indent) +
        renderTextWithStyles(truncateEllipsis(spec.description, Math.max(0, width - indent)), {
          color: Color.muted,
        }),
    );
  }
  while (lines.length < rows) lines.push("");
  return lines.slice(0, rows);
}

export function listOverflowLine(
  direction: "up" | "down",
  count: number | undefined,
  suffix: "above" | "below" | undefined,
  paddingLeft = 0,
): string {
  const arrow = direction === "up" ? Glyph.arrowUp : Glyph.arrowDown;
  const label = `${arrow}${count === undefined ? "" : ` ${count}`} more${
    suffix === undefined ? "" : ` ${suffix}`
  }`;
  return " ".repeat(paddingLeft) + renderTextWithStyles(label, { color: Color.muted });
}

export function panelDividerLine(width: number): string {
  return renderTextWithStyles(Glyph.boxHLine.repeat(Math.max(0, width)), { color: Color.border });
}

/**
 * Bare horizontal rule of `width` cells, uncolored. Frames that compose a rule out
 * of segments — a boxed pane with its title inset into the top edge — take the run
 * from here so rule drawing stays in one place and they only decide the joins.
 */
export function panelRuleSegment(width: number): string {
  return Glyph.boxHLine.repeat(Math.max(0, width));
}

/**
 * Hints pack greedily into rows that fit the frame; a narrow terminal wraps the
 * overflow onto following rows instead of clipping the trailing hints away.
 */
function footerHintsLines(hints: [string, string][], paddingX: number, width: number): string[] {
  const budget = Math.max(1, width - paddingX);
  const rows: string[][] = [];
  let current: string[] = [];
  let currentWidth = 0;
  for (const [key, label] of hints) {
    const text = `${key} ${label}`;
    const added = (current.length > 0 ? stringWidth(HINT_JOINER) : 0) + stringWidth(text);
    if (current.length > 0 && currentWidth + added > budget) {
      rows.push(current);
      current = [];
      currentWidth = 0;
    }
    currentWidth += current.length > 0 ? added : stringWidth(text);
    current.push(text);
  }
  if (current.length > 0) rows.push(current);
  return rows.map(
    (row) =>
      " ".repeat(paddingX) +
      renderTextWithStyles(row.join(HINT_JOINER), { color: Color.muted, italic: true }),
  );
}

function searchBoxLines(search: PanelSearch, width: number): string[] {
  const outerWidth = Math.max(3, width - CONTENT_PAD_X * 2);
  const innerWidth = Math.max(1, outerWidth - 4);
  const borderStyle = search.focused
    ? { color: Color.panelAccent }
    : { color: Color.border, dim: true };
  const rule = Glyph.boxHLine.repeat(outerWidth - 2);
  const top =
    CONTENT_INDENT + renderTextWithStyles(Glyph.boxTopLeft + rule + Glyph.boxTopRight, borderStyle);
  const bottom =
    CONTENT_INDENT +
    renderTextWithStyles(Glyph.boxBottomLeft + rule + Glyph.boxBottomRight, borderStyle);
  const content = searchContent(search, innerWidth);
  const mid =
    CONTENT_INDENT +
    renderTextWithStyles(Glyph.boxPipe, borderStyle) +
    " " +
    content +
    " " +
    renderTextWithStyles(Glyph.boxPipe, borderStyle);
  return [top, mid, bottom];
}

function searchContent(search: PanelSearch, innerWidth: number): string {
  const prefix = `${Glyph.search} `;
  const budget = Math.max(0, innerWidth - stringWidth(prefix));
  let content: string;
  if (search.query.length > 0 && search.focused) {
    content = prefix + caretQueryContent(search, budget);
  } else if (search.query.length > 0) {
    const query = truncateEllipsis(search.query, budget);
    content =
      renderTextWithStyles(prefix, { color: Color.muted }) +
      renderTextWithStyles(query, { color: Color.muted });
  } else if (search.focused) {
    const [first = " ", ...rest] = [...search.placeholder];
    content =
      prefix +
      renderTextWithStyles(first, { inverse: true }) +
      renderTextWithStyles(rest.join(""), { color: Color.muted });
  } else {
    content = renderTextWithStyles(prefix + search.placeholder, { color: Color.muted });
  }
  const padding = Math.max(0, innerWidth - stringWidth(content));
  return content + " ".repeat(padding);
}

/**
 * Focused query with the caret drawn at its offset. When the query outgrows the
 * box, a cell-budgeted window slides to keep the caret visible, with ellipses
 * marking the hidden ends.
 */
function caretQueryContent(search: PanelSearch, budget: number): string {
  const chars = [...search.query];
  const caret = Math.max(0, Math.min(chars.length, search.cursorOffset ?? chars.length));
  const caretCells = caret === chars.length ? 1 : 0;
  let start = caret;
  let usedCells = caretCells + (caret < chars.length ? stringWidth(chars[caret] ?? " ") : 0);
  while (start > 0) {
    const cells = stringWidth(chars[start - 1] ?? "");
    if (usedCells + cells > Math.max(1, budget - 2)) break;
    usedCells += cells;
    start -= 1;
  }
  let end = caret < chars.length ? caret + 1 : caret;
  while (end < chars.length) {
    const cells = stringWidth(chars[end] ?? "");
    if (usedCells + cells > Math.max(1, budget - 2)) break;
    usedCells += cells;
    end += 1;
  }
  const headMark = start > 0 ? "…" : "";
  const tailMark = end < chars.length ? "…" : "";
  const left = chars.slice(start, caret).join("");
  const caretChar = caret < chars.length ? (chars[caret] ?? " ") : " ";
  const right = caret < chars.length ? chars.slice(caret + 1, end).join("") : "";
  return (
    renderTextWithStyles(headMark + left, { color: Color.text }) +
    renderTextWithStyles(caretChar, { inverse: true }) +
    renderTextWithStyles(right + tailMark, { color: Color.text })
  );
}
