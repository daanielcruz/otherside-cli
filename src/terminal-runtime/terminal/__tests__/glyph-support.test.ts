import { describe, expect, it } from "bun:test";
import { canRenderGeometricShapesCleanly } from "@/terminal-runtime/terminal/glyph-support.ts";

describe("geometric shape glyph support", () => {
  it("uses cell-aligned glyphs for Ghostty", () => {
    expect(canRenderGeometricShapesCleanly("ghostty")).toBe(false);
  });

  it("keeps geometric shapes for other and unknown terminals", () => {
    expect(canRenderGeometricShapesCleanly("iTerm.app")).toBe(true);
    expect(canRenderGeometricShapesCleanly("unknown")).toBe(true);
  });
});
