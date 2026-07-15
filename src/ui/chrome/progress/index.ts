import { listCompletions } from "@/commands/index.ts";
import { stringWidth } from "@/kernel/std/text/string-width.ts";

const SPINNER_FRAMES = ["◰", "◳", "◲", "◱"] as const;

export { pickVerbForTurn, TURN_COMPLETION_VERB } from "@/engine/queue/turn/verb.ts";

const SPINNER_FRAME_MS = 120;

export const SHIMMER_TICK_MS = 50;
const SHIMMER_LEAD_COLUMNS = 10;
const SHIMMER_GAP_COLUMNS = 20;

export type { SpinnerMode } from "@/store/app-store/slices/view.ts";

export function spinnerFrame(timeMs: number): string {
  return SPINNER_FRAMES[Math.floor(timeMs / SPINNER_FRAME_MS) % SPINNER_FRAMES.length] ?? "·";
}

export interface ShimmerSegments {
  before: string;
  shimmer: string;
  after: string;
}

function verbWidth(verb: string): number {
  let total = 0;
  for (const char of verb) total += stringWidth(char);
  return total;
}

export function shimmerColumnForTime(timeMs: number, width: number): number {
  const cycleLength = width + SHIMMER_GAP_COLUMNS;
  const tick = Math.floor(timeMs / SHIMMER_TICK_MS);
  return (tick % cycleLength) - SHIMMER_LEAD_COLUMNS;
}

export function shimmerSegments(verb: string, timeMs: number): ShimmerSegments {
  const width = verbWidth(verb);
  const center = shimmerColumnForTime(timeMs, width);
  const start = center - 1;
  const end = center + 1;
  if (start >= width || end < 0) return { before: verb, shimmer: "", after: "" };
  const clampedStart = Math.max(0, start);
  let column = 0;
  let before = "";
  let shimmer = "";
  let after = "";
  for (const char of verb) {
    const charCols = stringWidth(char);
    if (column + charCols <= clampedStart) before += char;
    else if (column > end) after += char;
    else shimmer += char;
    column += charCols;
  }
  return { before, shimmer, after };
}

export function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export function formatTurnDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (h > 0 || m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

export function tipAt(index: number): string {
  const tips = listCompletions("").map((command) => `/${command.name} — ${command.description}`);
  if (tips.length === 0) return "";
  const hash = Math.abs(Math.sin((index + 1) * 12.9898 + 78.233)) * 43758.5453;
  const randomIndex = Math.floor((hash - Math.floor(hash)) * tips.length);
  return tips[randomIndex] ?? "";
}
