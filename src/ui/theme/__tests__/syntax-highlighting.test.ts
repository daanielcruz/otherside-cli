import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import chalk from "chalk";
import {
  isSyntaxHighlightingEnabled,
  setSyntaxHighlightingEnabled,
} from "@/ui/theme/syntax-highlighting.ts";
import { renderMarkdownLines } from "@/ui/transcript/markdown/string-view-markdown.ts";
import { renderDiffAnsiLines } from "@/ui/transcript/tool-render/diff.ts";

// Colour is the thing under test, so the writer has to believe it can emit it.
beforeAll(() => {
  chalk.level = 3;
});

afterEach(() => {
  setSyntaxHighlightingEnabled(true);
});

const FENCE = ["```ts", "const answer = 42;", "```"].join("\n");

const PATCH = [
  "--- a/answer.ts",
  "+++ b/answer.ts",
  "@@ -1,1 +1,1 @@",
  "-const answer = 41;",
  "+const answer = 42;",
].join("\n");

/** Distinct colour runs, which is what per-token colouring adds. */
function colourRuns(text: string): number {
  return (text.match(/\x1b\[[0-9;]*m/g) ?? []).length;
}

describe("the syntax-highlighting switch", () => {
  test("starts on", () => {
    expect(isSyntaxHighlightingEnabled()).toBe(true);
  });

  test("a fenced block loses its per-token colour when it is off", () => {
    const coloured = renderMarkdownLines(FENCE, 80).join("\n");
    setSyntaxHighlightingEnabled(false);
    const plain = renderMarkdownLines(FENCE, 80).join("\n");
    expect(colourRuns(coloured)).toBeGreaterThan(colourRuns(plain));
    expect(plain).toContain("const answer = 42;");
  });

  test("a diff keeps its sides when it is off", () => {
    setSyntaxHighlightingEnabled(false);
    const off = renderDiffAnsiLines(PATCH, 80, "answer.ts");
    expect(off).not.toBeNull();
    const offBody = off!.bodyLines.join("\n");
    // The add/remove backgrounds are the diff's own colour, not the language's.
    expect(colourRuns(offBody)).toBeGreaterThan(0);
    expect(offBody).toContain("42");

    setSyntaxHighlightingEnabled(true);
    const on = renderDiffAnsiLines(PATCH, 80, "answer.ts");
    expect(colourRuns(on!.bodyLines.join("\n"))).toBeGreaterThan(colourRuns(offBody));
  });

  test("a diff with no file path is unchanged by the switch", () => {
    const on = renderDiffAnsiLines(PATCH, 80);
    setSyntaxHighlightingEnabled(false);
    const off = renderDiffAnsiLines(PATCH, 80);
    expect(off!.bodyLines).toEqual(on!.bodyLines);
  });
});
