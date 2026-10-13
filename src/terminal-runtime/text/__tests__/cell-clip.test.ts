import { describe, expect, it } from "bun:test";
import { cellClip } from "@/terminal-runtime/text/cell-clip.ts";
import { stringWidth } from "@/terminal-runtime/text/cell-width.ts";

describe("cellClip", () => {
  it("returns a row that already fits unchanged", () => {
    expect(cellClip("◳ Thinking… (2s)", 16)).toBe("◳ Thinking… (2s)");
  });

  it("marks the cut with an ellipsis inside the width", () => {
    expect(cellClip("◳ Adjusting the call", 8)).toBe("◳ Adjus…");
  });

  it("drops a wide glyph that straddles the cut instead of overhanging the width", () => {
    const clipped = cellClip("a界界界界界", 5);

    expect(clipped).toBe("a界…");
    expect(stringWidth(clipped)).toBeLessThanOrEqual(5);
  });

  it("keeps styling closed across the cut", () => {
    const clipped = cellClip("\u001b[31mreasoned for 5s\u001b[39m", 9);

    expect(clipped).toBe("\u001b[31mreasoned\u001b[39m…");
  });
});
