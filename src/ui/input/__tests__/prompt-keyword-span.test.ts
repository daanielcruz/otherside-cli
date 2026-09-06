import { beforeAll, describe, expect, test } from "bun:test";
import chalk from "chalk";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.js";
import { type PromptStyledRange, promptContentRows } from "@/ui/input/prompt-chrome.ts";
import { promptDisplayRows } from "@/ui/input/prompt-text.ts";

beforeAll(() => {
  chalk.level = 3;
});

function rowsFor(text: string, columns: number, styledRanges: PromptStyledRange[]): string[] {
  return promptContentRows({
    rows: promptDisplayRows(text, text.length, columns),
    bashMode: false,
    commandTokenLength: 0,
    argHint: null,
    caretLit: false,
    styledRanges,
  });
}

/** The text inside each bold run of a row. */
function boldRuns(row: string): string[] {
  return [...row.matchAll(/\u001b\[1m([^\u001b]*)/g)].map((match) => match[1] ?? "");
}

describe("a styled span on a row the text wrapped onto", () => {
  test("lands on the characters it names, not one column late", () => {
    // A wrap drops the character it broke on, so a renderer summing row lengths
    // puts every later row a column early — the span then starts inside the word.
    const text = "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj ultracode kkkk";
    const start = text.indexOf("ultracode");
    const rows = rowsFor(text, 60, [
      { start, end: start + "ultracode".length, styles: { bold: true } },
    ]);
    const wrapped = rows.find((row) => stripAnsi(row).includes("ultracode"));

    expect(wrapped).toBeDefined();
    expect(boldRuns(wrapped ?? "")).toEqual(["ultracode"]);
  });
});

describe("several spans on one row", () => {
  test("each is lit, and the text between them is not", () => {
    const text = "say ultracode and ultracode again";
    const first = text.indexOf("ultracode");
    const second = text.lastIndexOf("ultracode");
    const rows = rowsFor(text, 100, [
      { start: first, end: first + 9, styles: { bold: true } },
      { start: second, end: second + 9, styles: { bold: true } },
    ]);

    const plain = stripAnsi(rows[0] ?? "");
    expect(plain).toContain("say ultracode and ultracode again");
    expect(boldRuns(rows[0] ?? "")).toEqual(["ultracode", "ultracode"]);
  });

  test("no spans leaves the row unstyled", () => {
    const rows = rowsFor("nothing to light here", 100, []);
    expect(stripAnsi(rows[0] ?? "")).toContain("nothing to light here");
  });
});
