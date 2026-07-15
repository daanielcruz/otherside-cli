import { clamp } from "@/kernel/std/math.ts";

const HALF_DIVISOR = 2;
const SCROLL_UP_ARROW = "↑";
const SCROLL_DOWN_ARROW = "↓";
const SCROLL_RANGE_DASH = "–";

export type ListWindowAnchor = "center" | "bottom";

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
}): ListWindow {
  const { cursor, total, size, anchor } = input;
  if (total <= size) {
    return { from: 0, to: total, size, above: 0, below: 0 };
  }
  const from = anchorStart({ cursor, total, size, anchor });
  const to = from + size;
  return { from, to, size, above: from, below: total - to };
}

function anchorStart(input: {
  cursor: number;
  total: number;
  size: number;
  anchor: ListWindowAnchor;
}): number {
  const { cursor, total, size, anchor } = input;
  if (anchor === "bottom") {
    return clamp(cursor - size + 1, 0, total - size);
  }
  const half = Math.floor(size / HALF_DIVISOR);
  return clamp(cursor - half, 0, total - size);
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
