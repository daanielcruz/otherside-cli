import { clamp } from "@/kernel/std/math.ts";

const HALF_DIVISOR = 2;
const SCROLL_UP_ARROW = "↑";
const SCROLL_DOWN_ARROW = "↓";
const SCROLL_RANGE_DASH = "–";

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

export function formatScrollWindowLabel(input: {
  win: Pick<ListWindow, "from" | "to">;
  total: number;
}): string {
  const { win, total } = input;
  const up = win.from > 0 ? SCROLL_UP_ARROW : " ";
  const down = win.to < total ? SCROLL_DOWN_ARROW : " ";
  return `${up} ${win.from + 1}${SCROLL_RANGE_DASH}${win.to} of ${total} ${down}`;
}
