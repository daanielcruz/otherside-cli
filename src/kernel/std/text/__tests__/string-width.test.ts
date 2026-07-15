import { describe, expect, it } from "bun:test";
import { stringWidth } from "@/kernel/std/text/string-width.ts";

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
});
