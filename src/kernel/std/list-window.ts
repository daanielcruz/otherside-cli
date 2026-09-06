import { clamp, clampIndex } from "@/kernel/std/math.ts";

const HALF_DIVISOR = 2;
const SCROLL_UP_ARROW = "↑";
const SCROLL_DOWN_ARROW = "↓";

export type ListWindowAnchor = "center" | "bottom" | "edge";

export interface ListWindow {
  from: number;
  to: number;
  size: number;
  above: number;
  below: number;
}

export function computeListWindow(input: {
  cursor: number;
  total: number;
  size: number;
  anchor: ListWindowAnchor;
  previousStart?: number;
}): ListWindow {
  const { cursor, total, size } = input;
  if (total <= size) {
    return { from: 0, to: total, size, above: 0, below: 0 };
  }
  const from = anchorStart(input);
  const to = from + size;
  return { from, to, size, above: from, below: total - to };
}

function anchorStart(input: {
  cursor: number;
  total: number;
  size: number;
  anchor: ListWindowAnchor;
  previousStart?: number;
}): number {
  const { cursor, total, size, anchor, previousStart } = input;
  const maxStart = Math.max(0, total - size);
  if (anchor === "bottom") {
    return clamp(cursor - size + 1, 0, maxStart);
  }
  if (anchor === "edge") {
    let start = clamp(previousStart ?? 0, 0, maxStart);
    if (cursor >= 0 && size > 0) {
      if (cursor < start) start = cursor;
      else if (cursor >= start + size) start = cursor - size + 1;
    }
    return clamp(start, 0, maxStart);
  }
  const half = Math.floor(size / HALF_DIVISOR);
  return clamp(cursor - half, 0, maxStart);
}

/** Marker rows the item-count policy shows for hidden items; rendered dim by the chrome. */
const ITEM_COUNT_MARKER_ABOVE = ` ${SCROLL_UP_ARROW} more above`;
const ITEM_COUNT_MARKER_BELOW = ` ${SCROLL_DOWN_ARROW} more below`;

export interface ItemCountWindow extends ListWindow {
  /** ` ${SCROLL_UP_ARROW} more above` when items hide above — leading space, no count. */
  markerAbove: string | undefined;
  /** ` ${SCROLL_DOWN_ARROW} more below` when items hide below — leading space, no count. */
  markerBelow: string | undefined;
  /** `(N/M)` cursor-position counter for an optional heading suffix. */
  counter: string;
}

/**
 * Item-count window policy: a fixed number of visible items with an anchor-scroll
 * clamp — the window keeps its previous start and slides only when the cursor
 * leaves it. Marker text is part of the policy so every adopter shows the same
 * words; the chrome renders the markers dim.
 */
export function computeItemCountWindow(input: {
  cursor: number;
  total: number;
  visibleCount: number;
  previousStart?: number;
}): ItemCountWindow {
  const { cursor, total, visibleCount, previousStart } = input;
  const window = computeListWindow({
    cursor,
    total,
    size: visibleCount,
    anchor: "edge",
    ...(previousStart !== undefined ? { previousStart } : {}),
  });
  const position = total === 0 ? 0 : clampIndex(cursor, total) + 1;
  return {
    ...window,
    markerAbove: window.above > 0 ? ITEM_COUNT_MARKER_ABOVE : undefined,
    markerBelow: window.below > 0 ? ITEM_COUNT_MARKER_BELOW : undefined,
    counter: `(${position}/${total})`,
  };
}

export interface RowBudgetWindow {
  from: number;
  to: number;
  above: number;
  below: number;
  /** `${SCROLL_UP_ARROW} N more above` when items hide above — count, no leading space. */
  markerAbove: string | undefined;
  /** `${SCROLL_DOWN_ARROW} N more below` when items hide below — count, no leading space. */
  markerBelow: string | undefined;
}

/**
 * Rows a windowed body may occupy in a terminal of `terminalRows` after the frame
 * spends `reservedRows`, clamped into `[floorRows, capRows]`. The floor keeps a
 * tiny terminal usable; the cap keeps a tall one from drowning the transcript.
 */
export function terminalRowBudget(input: {
  terminalRows: number;
  reservedRows: number;
  floorRows: number;
  capRows: number;
}): number {
  return clamp(Math.floor(input.terminalRows) - input.reservedRows, input.floorRows, input.capRows);
}

/**
 * Row-budget window policy: items charge a variable number of rows against a
 * terminal-derived budget (see {@link terminalRowBudget}); each overflowing side
 * charges one marker row. The window keeps its previous start and slides only
 * when the cursor leaves it; the cursor item is always visible, even when it is
 * taller than the whole budget.
 */
export function computeRowBudgetWindow(input: {
  cursor: number;
  /** Rows each item charges against the budget, in list order. */
  itemRows: readonly number[];
  budgetRows: number;
  previousStart?: number;
}): RowBudgetWindow {
  const { cursor, itemRows, budgetRows, previousStart } = input;
  const total = itemRows.length;
  if (total === 0) {
    return { from: 0, to: 0, above: 0, below: 0, markerAbove: undefined, markerBelow: undefined };
  }
  if (chargedRows(itemRows, 0, total) <= budgetRows) {
    return {
      from: 0,
      to: total,
      above: 0,
      below: 0,
      markerAbove: undefined,
      markerBelow: undefined,
    };
  }

  const target = clampIndex(cursor, total);
  let from = Math.min(clampIndex(previousStart ?? 0, total), target);
  let to = rowBudgetWindowEnd(itemRows, from, budgetRows);
  while (target >= to) {
    from += 1;
    to = rowBudgetWindowEnd(itemRows, from, budgetRows);
  }

  const above = from;
  const below = total - to;
  return {
    from,
    to,
    above,
    below,
    markerAbove: above > 0 ? `${SCROLL_UP_ARROW} ${above} more above` : undefined,
    markerBelow: below > 0 ? `${SCROLL_DOWN_ARROW} ${below} more below` : undefined,
  };
}

/** End of the window starting at `from`, charging marker rows on each hidden side. */
function rowBudgetWindowEnd(itemRows: readonly number[], from: number, budgetRows: number): number {
  const aboveMarkerRows = from > 0 ? 1 : 0;
  const fullEnd = fillRows(itemRows, from, budgetRows - aboveMarkerRows);
  if (fullEnd >= itemRows.length) return fullEnd;
  const belowMarkerRows = 1;
  const partialEnd = fillRows(itemRows, from, budgetRows - aboveMarkerRows - belowMarkerRows);
  return Math.max(partialEnd, from + 1);
}

/** Largest `end` such that items `[from, end)` fit into `budgetRows`. */
function fillRows(itemRows: readonly number[], from: number, budgetRows: number): number {
  let rows = 0;
  let end = from;
  while (end < itemRows.length && rows + (itemRows[end] ?? 1) <= budgetRows) {
    rows += itemRows[end] ?? 1;
    end += 1;
  }
  return end;
}

function chargedRows(itemRows: readonly number[], from: number, to: number): number {
  let rows = 0;
  for (let index = from; index < to; index++) rows += itemRows[index] ?? 1;
  return rows;
}
