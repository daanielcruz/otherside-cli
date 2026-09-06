import { describe, expect, it } from "bun:test";
import {
  COMPACT_MAX_RATIO,
  compactProgressRatio,
  SHIMMER_PAINT_MS,
  SHIMMER_TICK_MS,
  shimmerColumnForTime,
  spinnerFrame,
} from "@/ui/chrome/progress/index.ts";

describe("progress animation cadence", () => {
  it("keeps the spinner on its 120ms frame cadence", () => {
    expect(spinnerFrame(0)).toBe("◰");
    expect(spinnerFrame(119)).toBe("◰");
    expect(spinnerFrame(120)).toBe("◳");
  });

  it("moves shimmer every 40ms without increasing paint frequency", () => {
    expect(SHIMMER_TICK_MS).toBe(40);
    expect(SHIMMER_PAINT_MS).toBe(100);
    expect(shimmerColumnForTime(0, 10)).toBe(-10);
    expect(shimmerColumnForTime(39, 10)).toBe(-10);
    expect(shimmerColumnForTime(40, 10)).toBe(-9);
  });

  it("caps compact progress under 100%", () => {
    expect(compactProgressRatio(0)).toBe(0);
    expect(compactProgressRatio(Number.MAX_SAFE_INTEGER)).toBe(COMPACT_MAX_RATIO);
  });
});
