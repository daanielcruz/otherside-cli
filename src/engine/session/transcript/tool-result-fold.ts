import type { ContentBlock } from "@/kernel/std/types/message.ts";

export type ToolResultBlock = Extract<ContentBlock, { type: "tool_result" }>;

// A tool_reference array must stay intact; anything else accepts folded text.
export function isFoldableToolResult(block: ContentBlock | undefined): block is ToolResultBlock {
  if (block?.type !== "tool_result") return false;
  return !(
    Array.isArray(block.content) && block.content.some((item) => item.type === "tool_reference")
  );
}

export function lastFoldableToolResult(blocks: readonly ContentBlock[]): ToolResultBlock | null {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block?.type !== "tool_result") continue;
    return isFoldableToolResult(block) ? block : null;
  }
  return null;
}

// Append text into a tool_result's content, preserving the string shape when it was a string (the common Bash/Read case) and otherwise merging into a trailing text item so trailing siblings fold into the last result of a tool batch.
export function foldTextIntoToolResult(block: ToolResultBlock, text: string): void {
  const add = text.trim();
  if (add.length === 0) return;
  const existing = block.content;
  if (typeof existing === "string") {
    const base = existing.trim();
    block.content = base.length > 0 ? `${base}\n\n${add}` : add;
    return;
  }
  const last = existing[existing.length - 1];
  if (last?.type === "text") {
    existing[existing.length - 1] = { type: "text", text: `${last.text}\n\n${add}` };
  } else {
    existing.push({ type: "text", text: add });
  }
}
