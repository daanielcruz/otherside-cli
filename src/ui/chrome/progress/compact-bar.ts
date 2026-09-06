import { canRenderGeometricShapesCleanly } from "@/terminal-runtime/terminal/glyph-support.js";
import { Glyph } from "@/ui/theme/theme.ts";

export const PROGRESS_BAR_WIDTH = 40;
export const COMPACT_EASE_SECONDS = 90;
export const COMPACT_MAX_RATIO = 0.95;

export function compactProgressRatio(elapsedMs: number): number {
  const seconds = Math.max(0, elapsedMs) / 1000;
  return Math.min(COMPACT_MAX_RATIO, 1 - Math.exp(-seconds / COMPACT_EASE_SECONDS));
}

export function monotonicRatio(previous: number, candidate: number): number {
  return Math.max(previous, candidate);
}

export interface CompactProgressBarParts {
  readonly filled: string;
  readonly empty: string;
  readonly percentLabel: string;
  readonly ratio: number;
}

export function compactProgressBarParts(
  ratio: number,
  options: { geometric?: boolean; width?: number } = {},
): CompactProgressBarParts {
  const width = options.width ?? PROGRESS_BAR_WIDTH;
  const clamped = Math.min(1, Math.max(0, ratio));
  const filledCount = Math.round(clamped * width);
  const emptyCount = Math.max(0, width - filledCount);
  const geometric = options.geometric ?? canRenderGeometricShapesCleanly();
  const filledGlyph = geometric ? Glyph.barFilled : Glyph.block;
  const emptyGlyph = geometric ? Glyph.barEmpty : Glyph.blockLight;
  return {
    filled: filledGlyph.repeat(filledCount),
    empty: emptyGlyph.repeat(emptyCount),
    percentLabel: `${Math.round(clamped * 100)}%`,
    ratio: clamped,
  };
}
