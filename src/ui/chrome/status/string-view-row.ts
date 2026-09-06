import truncateAnsiString from "@/terminal-runtime/text/ansi-slice.js";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";

const HORIZONTAL_PADDING = 2;
/** Minimum columns kept between the left status and the right-aligned segment. */
const MIN_GAP = 2;
/** Share of the row a right-aligned segment may claim before the left status suffers. */
const RIGHT_LANE_SHARE = 0.45;

/** Columns a status row will spend on its right-aligned segment. */
export function rightLaneBudget(width: number): number {
  const columns = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  return Math.max(0, Math.min(Math.floor(columns * RIGHT_LANE_SHARE), columns - 4));
}

/**
 * Assemble one status row: left content, filler spaces, optional right-aligned
 * segment. When the row is too narrow, the right segment is dropped entirely
 * rather than overflowing; the left side then uses the full inner width.
 */
export function formatStatusRow(left: string, width: number, right?: string): string {
  const columns = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const pad = Math.min(HORIZONTAL_PADDING, columns);
  const inner = Math.max(0, columns - pad * 2);
  const leftPadding = " ".repeat(pad);

  if (right === undefined || right.length === 0 || inner === 0) {
    return leftPadding + truncateAnsiString(left, 0, inner);
  }

  const rightWidth = stringWidth(right);
  // Right segment must fit with a gap; otherwise drop it.
  if (rightWidth === 0 || rightWidth + MIN_GAP > inner) {
    return leftPadding + truncateAnsiString(left, 0, inner);
  }

  const leftBudget = Math.max(0, inner - rightWidth - MIN_GAP);
  const leftClipped = truncateAnsiString(left, 0, leftBudget);
  const leftWidth = stringWidth(leftClipped);
  const filler = Math.max(MIN_GAP, inner - leftWidth - rightWidth);
  return leftPadding + leftClipped + " ".repeat(filler) + right;
}
