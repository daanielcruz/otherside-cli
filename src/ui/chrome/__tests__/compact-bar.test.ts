import { describe, expect, it } from "bun:test";
import {
  COMPACT_EASE_SECONDS,
  COMPACT_MAX_RATIO,
  compactProgressBarParts,
  compactProgressRatio,
  monotonicRatio,
  PROGRESS_BAR_WIDTH,
} from "@/ui/chrome/progress/compact-bar.ts";
import { Glyph } from "@/ui/theme/theme.ts";

describe("compactProgressRatio", () => {
  it("starts at 0 and never exceeds the max cap", () => {
    expect(compactProgressRatio(0)).toBe(0);
    expect(compactProgressRatio(-1000)).toBe(0);
    expect(compactProgressRatio(COMPACT_EASE_SECONDS * 1000)).toBeCloseTo(1 - Math.exp(-1), 5);
    expect(compactProgressRatio(1_000_000_000)).toBe(COMPACT_MAX_RATIO);
    expect(compactProgressRatio(1_000_000_000)).toBeLessThan(1);
  });

  it("eases asymptotically toward the cap over time", () => {
    const early = compactProgressRatio(5_000);
    const mid = compactProgressRatio(30_000);
    const late = compactProgressRatio(180_000);
    expect(early).toBeLessThan(mid);
    expect(mid).toBeLessThan(late);
    expect(late).toBeLessThanOrEqual(COMPACT_MAX_RATIO);
  });
});

describe("monotonicRatio", () => {
  it("only advances the displayed ratio", () => {
    expect(monotonicRatio(0.2, 0.5)).toBe(0.5);
    expect(monotonicRatio(0.5, 0.3)).toBe(0.5);
    expect(monotonicRatio(0.5, 0.5)).toBe(0.5);
  });
});

describe("compactProgressBarParts", () => {
  it("formats a full-width bar with percent label", () => {
    const zero = compactProgressBarParts(0, { geometric: true });
    expect(zero.filled).toBe("");
    expect(zero.empty).toBe(Glyph.barEmpty.repeat(PROGRESS_BAR_WIDTH));
    expect(zero.percentLabel).toBe("0%");

    const half = compactProgressBarParts(0.5, { geometric: true });
    expect(half.filled).toBe(Glyph.barFilled.repeat(20));
    expect(half.empty).toBe(Glyph.barEmpty.repeat(20));
    expect(half.percentLabel).toBe("50%");

    const capped = compactProgressBarParts(COMPACT_MAX_RATIO, { geometric: true });
    expect(capped.filled.length + capped.empty.length).toBe(PROGRESS_BAR_WIDTH);
    expect(capped.percentLabel).toBe("95%");
  });

  it("falls back to block glyphs when geometric shapes are unavailable", () => {
    const parts = compactProgressBarParts(0.25, { geometric: false });
    expect(parts.filled).toBe(Glyph.block.repeat(10));
    expect(parts.empty).toBe(Glyph.blockLight.repeat(30));
  });
});
