import { describe, expect, it } from "bun:test";
import { createPatch } from "diff";
import { stripAnsi } from "@/terminal-runtime/text/presentation-sequences.ts";
import { renderDiffAnsiLines } from "@/ui/transcript/tool-render/diff.ts";

function rows(before: string, after: string, width = 40): string[] {
  const rendered = renderDiffAnsiLines(createPatch("notes.txt", before, after), width);
  return (rendered?.bodyLines ?? []).map((line) => stripAnsi(line).trimEnd());
}

describe("diff gutter", () => {
  it("sets the marker right after the line number, touching the text", () => {
    expect(rows("hello\n", "goodbye\n")).toEqual([" 1 -hello", " 1 +goodbye"]);
  });

  it("aligns unchanged lines under the changed ones", () => {
    expect(rows("keep\nold\n", "keep\nnew\n")).toEqual([" 1  keep", " 2 -old", " 2 +new"]);
  });
});
