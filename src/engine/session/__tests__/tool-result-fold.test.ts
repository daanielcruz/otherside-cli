import { describe, expect, it } from "bun:test";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
import {
  foldTextIntoToolResult,
  isFoldableToolResult,
  lastFoldableToolResult,
  type ToolResultBlock,
} from "../transcript/tool-result-fold.ts";

const NOTE = "<system-reminder>bg task done</system-reminder>";

function toolResult(content: ToolResultBlock["content"]): ToolResultBlock {
  return { type: "tool_result", tool_use_id: "toolu_1", content };
}

describe("foldTextIntoToolResult", () => {
  it("appends to a string result with a blank-line joiner", () => {
    const block = toolResult("line 1\nline 2");
    foldTextIntoToolResult(block, NOTE);
    expect(block.content).toBe(`line 1\nline 2\n\n${NOTE}`);
  });

  it("replaces an empty string result with the bare text", () => {
    const block = toolResult("");
    foldTextIntoToolResult(block, NOTE);
    expect(block.content).toBe(NOTE);
  });

  it("merges into a trailing text item of an array result", () => {
    const block = toolResult([{ type: "text", text: "out" }]);
    foldTextIntoToolResult(block, NOTE);
    expect(block.content).toEqual([{ type: "text", text: `out\n\n${NOTE}` }]);
  });

  it("ignores empty text", () => {
    const block = toolResult("out");
    foldTextIntoToolResult(block, "  \n ");
    expect(block.content).toBe("out");
  });
});

describe("lastFoldableToolResult", () => {
  it("finds the last tool_result in a batch", () => {
    const first = toolResult("a");
    const second = toolResult("b");
    const blocks: ContentBlock[] = [first, second];
    expect(lastFoldableToolResult(blocks)).toBe(second);
  });

  it("returns null when the last tool_result carries tool_reference content", () => {
    const blocks: ContentBlock[] = [
      toolResult([{ type: "tool_reference", tool_name: "Bash" } as never]),
    ];
    expect(lastFoldableToolResult(blocks)).toBeNull();
  });

  it("returns null for an empty batch", () => {
    expect(lastFoldableToolResult([])).toBeNull();
  });

  it("skips non-result trailing blocks", () => {
    const result = toolResult("a");
    const blocks: ContentBlock[] = [result, { type: "text", text: "sibling" }];
    expect(lastFoldableToolResult(blocks)).toBe(result);
  });
});

describe("isFoldableToolResult", () => {
  it("accepts an is_error result", () => {
    const block = { ...toolResult("boom"), is_error: true };
    expect(isFoldableToolResult(block)).toBe(true);
  });

  it("rejects non tool_result blocks", () => {
    expect(isFoldableToolResult({ type: "text", text: "x" })).toBe(false);
    expect(isFoldableToolResult(undefined)).toBe(false);
  });
});
