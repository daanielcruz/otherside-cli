import { describe, expect, it } from "bun:test";
import {
  deleteToVisualLineEnd,
  deleteToVisualLineStart,
  logicalLineEndOffset,
  logicalLineStartOffset,
  promptDisplayRows,
  splitRowByRange,
  visualLineEndOffset,
  visualLineStartOffset,
} from "@/ui/input/prompt-text.ts";

describe("splitRowByRange", () => {
  it("returns the whole row plain without a range", () => {
    expect(splitRowByRange("hello world", 0, null)).toEqual([
      { text: "hello world", style: "plain" },
    ]);
  });

  it("styles only the overlapping slice of a row", () => {
    expect(splitRowByRange("hello dictated world", 0, { start: 6, end: 14, style: "dim" })).toEqual(
      [
        { text: "hello ", style: "plain" },
        { text: "dictated", style: "dim" },
        { text: " world", style: "plain" },
      ],
    );
  });

  it("maps the range through the row's absolute start", () => {
    expect(splitRowByRange("second row", 20, { start: 20, end: 26, style: "match" })).toEqual([
      { text: "second", style: "match" },
      { text: " row", style: "plain" },
    ]);
  });

  it("leaves rows outside the range untouched", () => {
    expect(splitRowByRange("before", 0, { start: 40, end: 50, style: "dim" })).toEqual([
      { text: "before", style: "plain" },
    ]);
  });
});

describe("promptDisplayRows row starts", () => {
  it("tracks each wrapped row's absolute offset", () => {
    const text = "alpha beta gamma delta";
    const rows = promptDisplayRows(text, text.length, 18);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]?.start).toBe(0);
    for (const row of rows.slice(0, -1)) {
      // Rows past the first begin where the display text places them.
      expect(text.startsWith(row.text.trimEnd(), row.start)).toBe(true);
    }
  });
});

describe("promptDisplayRows cursor rendering", () => {
  it("keeps logical lines separate when the cursor sits on the newline", () => {
    const rows = promptDisplayRows("abc\ndef", 3, 40);
    expect(rows.map((row) => row.text)).toEqual(["abc ", "def"]);
    expect(rows[0]?.cursorOffset).toBe(3);
    expect(rows[0]?.cursorChar).toBe(" ");
    expect(rows[1]?.cursorOffset).toBeNull();
  });

  it("renders an inverted space when the cursor is at end of text", () => {
    const rows = promptDisplayRows("abc", 3, 40);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("abc ");
    expect(rows[0]?.cursorOffset).toBe(3);
    expect(rows[0]?.cursorChar).toBe(" ");
  });

  it("treats U+E000 in user text as plain content", () => {
    const text = "ab\uE000cd";
    const rows = promptDisplayRows(text, text.length - 1, 40);
    expect(rows[0]?.cursorOffset).toBe(4);
    expect(rows[0]?.cursorChar).toBe("d");
    expect(rows[0]?.text).toBe("ab\uE000cd");
  });

  it("wraps a wide grapheme under the cursor by its real width", () => {
    // Wrap width is columns - 4; at 20 columns a row holds 16 cells. The
    // emoji (2 cells) exceeds the remaining cell and wraps whole.
    const text = `${"a".repeat(15)}😀bb`;
    const withCursorOnEmoji = promptDisplayRows(text, 15, 20);
    const withCursorAtEnd = promptDisplayRows(text, text.length, 20);
    expect(withCursorOnEmoji.map((row) => row.text.trimEnd())).toEqual(
      withCursorAtEnd
        .slice(0, -1)
        .map((row) => row.text.trimEnd())
        .concat("😀bb"),
    );
    expect(withCursorOnEmoji[1]?.cursorChar).toBe("😀");
    expect(withCursorOnEmoji[1]?.cursorColumn).toBe(0);
  });

  it("reports the cursor column in display cells, not string offsets", () => {
    const rows = promptDisplayRows("日本語x", 3, 40);
    expect(rows[0]?.cursorOffset).toBe(3);
    expect(rows[0]?.cursorColumn).toBe(6);
  });
});

describe("line-scoped operations", () => {
  // "abc\ndef" — newline at 3, second line spans 4..7.
  const text = "abc\ndef";

  it("logical line bounds resolve against newlines", () => {
    expect(logicalLineStartOffset(text, 6)).toBe(4);
    expect(logicalLineEndOffset(text, 5)).toBe(7);
    expect(logicalLineStartOffset(text, 2)).toBe(0);
    expect(logicalLineEndOffset(text, 2)).toBe(3);
  });

  it("visual line bounds resolve against wrapped rows", () => {
    expect(visualLineStartOffset(text, 6, 40)).toBe(4);
    expect(visualLineEndOffset(text, 5, 40)).toBe(7);
  });

  it("home at column 0 climbs to the previous row", () => {
    expect(visualLineStartOffset(text, 4, 40)).toBe(0);
  });

  it("kill to line end stops at the row, not the buffer", () => {
    expect(deleteToVisualLineEnd(text, 1, 40)).toEqual({
      text: "a\ndef",
      cursor: 1,
      killed: "bc",
    });
  });

  it("kill to line end on a newline eats just the newline", () => {
    expect(deleteToVisualLineEnd(text, 3, 40)).toEqual({
      text: "abcdef",
      cursor: 3,
      killed: "\n",
    });
  });

  it("kill to line start stops at the row, not the buffer", () => {
    expect(deleteToVisualLineStart(text, 6, 40)).toEqual({
      text: "abc\nf",
      cursor: 4,
      killed: "de",
    });
  });

  it("kill to line start right after a newline eats just the newline", () => {
    expect(deleteToVisualLineStart(text, 4, 40)).toEqual({
      text: "abcdef",
      cursor: 3,
      killed: "\n",
    });
  });
});
