import { useRepeatingClock } from "@/ink";
import { getIsScrollDraining } from "@/kernel/std/state/scroll-activity.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";
import type { TranscriptEntry } from "@/ui/transcript/types";

export function useSharedIntervalTick(tick: () => void, intervalMs: number | null): void {
  useRepeatingClock(() => {
    if (getIsScrollDraining()) return;
    tick();
  }, intervalMs);
}

export function thousandsValue(k: number): number | string {
  if (Number.isInteger(k)) return k;
  if (k >= 100) return Math.round(k);
  return k.toFixed(1);
}

export function prefixFor(kind: TranscriptEntry["kind"]): string {
  if (kind === "user") return Glyph.chevron;
  if (kind === "assistant") return `${Glyph.bullet} `;
  if (kind === "compaction") return `${Glyph.bullet} `;
  if (kind === "compact_done") return `${Glyph.lozenge} `;
  return Glyph.systemBullet;
}

export function colorFor(kind: TranscriptEntry["kind"]): (typeof Color)[keyof typeof Color] {
  if (kind === "user") return Color.user;
  if (kind === "assistant") return Color.assistant;
  if (kind === "thinking") return Color.muted;
  if (kind === "compact_done") return Color.muted;
  if (kind === "compaction") return Color.muted;
  return Color.system;
}
