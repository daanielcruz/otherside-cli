import type { Color as InkColor } from "@/ink";
import { CROSS, TICK } from "@/ui/chrome/progress/glyphs.ts";
import { Color } from "@/ui/theme/theme.ts";

export const WIDTH_FLOOR = 24;
export const WIDTH_MARGIN = 6;
export const CONTENT_FLOOR = 12;
export const CONTENT_MARGIN = 6;
export const LIVE_TICK_MS = 1000;

export const INNER_INSET = 9;
export const AGENT_LABEL_FLOOR = 14;
export const AGENT_LABEL_PAD = 4;
export const AGENT_LEFT_MIN = 12;
export const AGENT_LEFT_MAX = 30;
export const SPLIT_MIN_WIDTH = 64;
export const AGENT_RIGHT_MIN = 30;

export const TIGHT_ROWS = 18;
export const TIGHT_BODY_MARGIN = 8;
export const WIDE_BODY_MARGIN = 11;
export const PHASE_LIST_TAIL = 3;
export const PHASE_LEFT_MIN = 12;
export const PHASE_LEFT_MAX = 34;
export const PHASE_INNER_INSET = 24;
export const PHASE_RIGHT_MIN = 20;
export const PHASE_COL_FLOOR = 14;
export const PHASE_COL_POINTER = 2;

export const TIGHT_CARD_WIDE_MARGIN = 7;
export const WIDE_CARD_WIDE_MARGIN = 8;
export const TIGHT_CARD_NARROW_MARGIN = 8;
export const WIDE_CARD_NARROW_MARGIN = 9;
export const CARD_NARROW_FLOOR = 3;

export const NOW_BUCKET_MS = 1000;
export const MIN_HEIGHT_TIGHT = 8;
export const MIN_HEIGHT_WIDE = 12;
export const MAX_HEIGHT_WIDE = 12;
export const ROWS_MARGIN = 6;
export const PHASE_ROW_WIDTH = 17;

export const ARROW_UP = "↑";
export const ARROW_DOWN = "↓";

export function phaseColGlyph(input: {
  status: "not-started" | "running" | "done" | "failed";
  index: number;
}): string {
  const { status, index } = input;
  if (status === "done") return TICK;
  if (status === "failed") return CROSS;
  return String(index + 1);
}

export function phaseRowGlyph(input: {
  isDone: boolean;
  isFailed: boolean;
  index: number;
}): string {
  const { isDone, isFailed, index } = input;
  if (isDone) return TICK;
  if (isFailed) return CROSS;
  return String(index);
}

export function phaseRowColor(input: {
  selected: boolean;
  isDone: boolean;
  isFailed: boolean;
}): InkColor | undefined {
  const { selected, isDone, isFailed } = input;
  if (selected) return Color.primaryGlow;
  if (isDone) return Color.success;
  if (isFailed) return Color.error;
  return undefined;
}
