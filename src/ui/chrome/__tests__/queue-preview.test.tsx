import { describe, expect, test } from "bun:test";
import { stringWidth } from "@/kernel/std/text/string-width.ts";
import { wrapText } from "@/kernel/std/text/wrapping.ts";
import { Glyph } from "@/ui/theme/theme.ts";
import { queueRowParts } from "../queue-preview.tsx";

const LEFT_INDENT = 2;
const INNER_PAD = 1;

function renderedRows(columns: number, text: string): string[] {
  const width = columns - LEFT_INDENT;
  const textBudget = Math.max(1, width - INNER_PAD - stringWidth(Glyph.chevron));
  return wrapText(text, textBudget).map((line, index) => {
    const { prefix, filler } = queueRowParts(line, index === 0, width);
    return `${" ".repeat(LEFT_INDENT)}${prefix}${line}${" ".repeat(INNER_PAD)}${filler}`;
  });
}

describe("queued message preview", () => {
  test("fills the indented band on every wrapped row", () => {
    const rows = renderedRows(24, "one two three four five six seven");

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => stringWidth(row) === 24)).toBe(true);
    expect(rows[0]?.startsWith("  ❯ ")).toBe(true);
    expect(rows[1]?.startsWith("    ")).toBe(true);
  });

  test("keeps wrapped rows inside a narrow terminal", () => {
    const rows = renderedRows(12, "one two three four five six seven");

    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((row) => stringWidth(row) <= 12)).toBe(true);
    expect(rows[0]?.startsWith("  ❯ ")).toBe(true);
    expect(rows.slice(1).every((row) => row.startsWith("    "))).toBe(true);
  });
});
