import { describe, expect, it } from "bun:test";
import { paintCellWidth, stringWidth } from "@/terminal-runtime/text/cell-width.ts";
import { splitByColumnWidth } from "@/terminal-runtime/text/column-chunks.ts";
import { wrapLine, wrapText } from "@/terminal-runtime/text/plain-wrap.ts";

describe("stringWidth", () => {
  it("measures ASCII, CJK, emoji, and controls", () => {
    expect(stringWidth("abc")).toBe(3);
    expect(stringWidth("字")).toBe(2);
    expect(stringWidth("😀")).toBe(2);
    expect(stringWidth("👨‍👩‍👧‍👦")).toBe(2);
    expect(stringWidth("\t")).toBe(0);
  });

  it("distinguishes text and emoji presentation", () => {
    expect(stringWidth("☃")).toBe(1);
    expect(stringWidth("☃️")).toBe(2);
    expect(stringWidth("❤")).toBe(1);
    expect(stringWidth("❤️")).toBe(2);
    expect(stringWidth("1️⃣")).toBe(2);
    expect(stringWidth("1⃣")).toBe(2);
  });

  it("supports ambiguous-width and ANSI options", () => {
    expect(stringWidth("·")).toBe(1);
    expect(stringWidth("·", { ambiguousIsNarrow: false })).toBe(2);
    expect(stringWidth("\u001b[31mred\u001b[0m")).toBe(3);
    expect(stringWidth("\u001b[31mred\u001b[0m", { countAnsiEscapeCodes: true })).toBe(10);
  });

  it("preserves the paint engine contract for an 8-bit CSI introducer", () => {
    const colored = "\u009b31mred\u009b0m";
    expect(paintCellWidth(colored)).toBe(8);
    expect(stringWidth(colored)).toBe(3);
  });

  it.each([
    "plain",
    "字",
    "👨‍👩‍👧‍👦",
    "e\u0301",
    "☃️",
  ])("keeps painted and projected width aligned for %s", (value) => {
    expect(paintCellWidth(value)).toBe(stringWidth(value));
  });
});

describe("column geometry", () => {
  it("splits graphemes without breaking their source offsets", () => {
    expect(splitByColumnWidth("alpha😀beta", 5)).toEqual([
      { text: "alpha", start: 0, end: 5 },
      { text: "😀bet", start: 5, end: 10 },
      { text: "a", start: 10, end: 11 },
    ]);
  });

  it("preserves word separators and hard-wraps oversized words", () => {
    expect(wrapLine("one two three", { width: 7 })).toEqual(["one ", "two ", "three"]);
    expect(wrapLine("extraordinary", { width: 4 })).toEqual(["extr", "aord", "inar", "y"]);
    expect(wrapText("one two\n\nthree", 5)).toEqual(["one ", "two", "", "three"]);
  });
});
