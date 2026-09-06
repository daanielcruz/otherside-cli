import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { panelRuleSegment } from "@/ui/chrome/string-view-panel.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

/**
 * Two columns of rows inside one box, each column named by a title inset into the
 * top rule. The box is sized to the frame rather than to its contents, so a pane
 * holding two rows and a pane holding thirty draw the same outline.
 */

/** Below this the columns cannot both stay readable, so the caller stacks instead. */
export const SPLIT_PANE_MIN_WIDTH = 70;
/** Cells a title costs beyond its own text: the space on each side of it. */
const TITLE_MARGIN = 2;
/** Cells of padding inside each column, left and right. */
const PANE_PAD = 1;

export interface SplitPaneColumn {
  title: string;
  rows: readonly string[];
  /** Columns the pane occupies, borders excluded. */
  width: number;
}

export interface SplitPaneSpec {
  left: SplitPaneColumn;
  right: SplitPaneColumn;
  /** Interior rows to draw, blank-filled when a column runs short. */
  height: number;
}

/**
 * Split a frame's usable width between a fixed-width left column and whatever is
 * left for the right. Returns null when the frame cannot carry two columns, which
 * is the caller's signal to stack them.
 */
export function splitPaneWidths(
  frameWidth: number,
  leftWidth: number,
): { left: number; right: number } | null {
  if (frameWidth < SPLIT_PANE_MIN_WIDTH) return null;
  // Three borders and the padding each column keeps on both sides.
  const chrome = 3 + PANE_PAD * 4;
  const right = frameWidth - leftWidth - chrome;
  return right > 0 ? { left: leftWidth, right } : null;
}

export function renderSplitPane(spec: SplitPaneSpec): string[] {
  const { left, right, height } = spec;
  const lines = [topRule(left, right)];
  for (let row = 0; row < Math.max(0, height); row++) {
    lines.push(interiorRow(left, right, row));
  }
  lines.push(bottomRule(left, right));
  return lines;
}

function topRule(left: SplitPaneColumn, right: SplitPaneColumn): string {
  return rule(
    Glyph.boxTopLeft,
    titledSegment(left),
    Glyph.boxTeeDown,
    titledSegment(right),
    Glyph.boxTopRight,
  );
}

function bottomRule(left: SplitPaneColumn, right: SplitPaneColumn): string {
  const span = (column: SplitPaneColumn): string => panelRuleSegment(paneCells(column));
  return rule(Glyph.boxBottomLeft, span(left), Glyph.boxTeeUp, span(right), Glyph.boxBottomRight);
}

function rule(
  open: string,
  leftSpan: string,
  join: string,
  rightSpan: string,
  close: string,
): string {
  return renderTextWithStyles(open + leftSpan + join + rightSpan + close, {
    color: Color.panelAccent,
  });
}

/**
 * A pane's stretch of the top rule with its title sitting in it. The title is
 * truncated before it can push the rule past its own column, because a rule that
 * overruns its width breaks every row beneath it.
 */
function titledSegment(column: SplitPaneColumn): string {
  const cells = paneCells(column);
  const room = Math.max(0, cells - TITLE_MARGIN);
  const title = truncateEllipsis(column.title, room);
  const titleCells = stringWidth(title);
  if (titleCells === 0) return panelRuleSegment(cells);
  const trailing = Math.max(0, cells - titleCells - TITLE_MARGIN);
  return ` ${title} ${panelRuleSegment(trailing)}`;
}

function interiorRow(left: SplitPaneColumn, right: SplitPaneColumn, row: number): string {
  const pipe = renderTextWithStyles(Glyph.boxPipe, { color: Color.panelAccent });
  return pipe + paneCell(left, row) + pipe + paneCell(right, row) + pipe;
}

/** One pane's cell on a row: its content padded to the pane's full width. */
function paneCell(column: SplitPaneColumn, row: number): string {
  const content = column.rows[row] ?? "";
  const room = column.width;
  const fitted = stringWidth(content) > room ? truncateEllipsis(content, room) : content;
  const filler = " ".repeat(Math.max(0, room - stringWidth(fitted)));
  return " ".repeat(PANE_PAD) + fitted + filler + " ".repeat(PANE_PAD);
}

/** Cells a pane spans on a rule: its content width plus the padding around it. */
function paneCells(column: SplitPaneColumn): number {
  return column.width + PANE_PAD * 2;
}
