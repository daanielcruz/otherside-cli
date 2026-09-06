import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import chalk from "chalk";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderMarkdownLines } from "@/ui/transcript/markdown/string-view-markdown.ts";

const originalColorLevel = chalk.level;
const originalForceHyperlink = process.env.FORCE_HYPERLINK;

beforeAll(() => {
  chalk.level = 3;
  process.env.FORCE_HYPERLINK = "1";
});

afterAll(() => {
  chalk.level = originalColorLevel;
  if (originalForceHyperlink === undefined) delete process.env.FORCE_HYPERLINK;
  else process.env.FORCE_HYPERLINK = originalForceHyperlink;
});

describe("renderMarkdownLines", () => {
  it("renders a level-one heading with the transcript heading styles", () => {
    expect(renderMarkdownLines("# Title", 80)).toEqual([
      "\x1b[1m\x1b[3m\x1b[4mTitle\x1b[24m\x1b[23m\x1b[22m",
    ]);
  });

  it("composes bold and italic paragraph styles", () => {
    expect(renderMarkdownLines("This is ***bold italic*** text.", 80)).toEqual([
      "This is \x1b[3m\x1b[1mbold italic\x1b[22m\x1b[23m text.",
    ]);
  });

  it("uses the active theme inline-code color", () => {
    expect(renderMarkdownLines("Use `value` here.", 80)).toEqual([
      "Use \x1b[38;2;177;185;249mvalue\x1b[39m here.",
    ]);
  });

  it("syntax-highlights a fenced code block", () => {
    expect(renderMarkdownLines("```ts\nconst answer = 42;\n```", 80)).toEqual([
      "\x1b[34mconst\x1b[39m answer = \x1b[32m42\x1b[39m;",
    ]);
  });

  it("renders an unordered list", () => {
    expect(renderMarkdownLines("- first\n- second", 80)).toEqual(["- first", "- second"]);
  });

  it("renders an ordered list", () => {
    expect(renderMarkdownLines("1. first\n2. second", 80)).toEqual(["1. first", "2. second"]);
  });

  it("renders an italic blockquote with the dim quarter-block glyph", () => {
    expect(renderMarkdownLines("> quoted words", 80)).toEqual([
      "\x1b[2m▎\x1b[22m \x1b[3mquoted words\x1b[23m",
    ]);
  });

  it("emits an OSC-8 hyperlink with the renderer link color", () => {
    expect(renderMarkdownLines("Visit [site](https://example.com).", 80)).toEqual([
      "Visit \x1b[94m\x1b]8;;https://example.com\x1b\\site\x1b]8;;\x1b\\\x1b[39m.",
    ]);
  });

  // The space a row was broken on belongs to the break, not to the row after it: the
  // colour sequence opening that row must not be followed by one, or the row sits a
  // column further in than its neighbours and the left edge stops reading straight.
  it("wraps long styled paragraphs without splitting SGR sequences or indenting the break", () => {
    const rows = renderMarkdownLines("**alpha beta gamma delta**", 10);

    expect(rows).toEqual([
      "\x1b[1malpha beta\x1b[22m",
      "\x1b[1mgamma \x1b[22m",
      "\x1b[1mdelta\x1b[22m",
    ]);
    expect(rows.every((row) => stringWidth(row) <= 10)).toBe(true);
    expect(rows.every(hasCompleteSgrSequences)).toBe(true);
  });

  it("returns no rows for blank input", () => {
    expect(renderMarkdownLines(" \n\t", 80)).toEqual([]);
  });

  it("opens an unnamed table on its data instead of a blank header band", () => {
    const rows = plainRows("|  |  |\n|---|---|\n| median | 3s |\n| mean | 33s |");

    expect(rows[0]).toStartWith("┌");
    expect(rows[1]).toContain("median");
    expect(rows.filter((row) => /^│[\s│]*│$/.test(row))).toEqual([]);
  });

  it("keeps the header band when the table names its columns", () => {
    const rows = plainRows("| Metric | Value |\n|---|---|\n| median | 3s |");

    expect(rows[1]).toContain("Metric");
    expect(rows[2]).toStartWith("├");
    expect(rows[3]).toContain("median");
  });

  it("keeps continuation rows aligned inside a wrapped table cell", () => {
    const rows = renderMarkdownLines(
      "| Detail |\n|---|\n| alpha beta xyz gamma delta epsilon |",
      22,
    ).map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));

    expect(rows.slice(3, 6)).toEqual([
      "│ alpha beta xyz │",
      "│ gamma delta    │",
      "│ epsilon        │",
    ]);
  });
});

function plainRows(markdown: string): string[] {
  return renderMarkdownLines(markdown, 60).map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
}

function hasCompleteSgrSequences(row: string): boolean {
  return !row.replace(/\x1b\[[0-9;]*m/g, "").includes("\x1b[");
}
