import { describe, expect, it } from "bun:test";
import { clampIndex, wrapIndex } from "../math.ts";

describe("clampIndex", () => {
  it("clamps into the index range and answers 0 for an empty range", () => {
    expect(clampIndex(2, 5)).toBe(2);
    expect(clampIndex(-1, 5)).toBe(0);
    expect(clampIndex(9, 5)).toBe(4);
    expect(clampIndex(3, 0)).toBe(0);
  });
});

describe("wrapIndex", () => {
  it("wraps both directions and answers 0 for an empty range", () => {
    expect(wrapIndex(4, 3)).toBe(1);
    expect(wrapIndex(-1, 3)).toBe(2);
    expect(wrapIndex(2, 3)).toBe(2);
    expect(wrapIndex(7, 0)).toBe(0);
  });
});
