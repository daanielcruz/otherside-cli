import { describe, expect, it } from "bun:test";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";
import { sanitizeMessages } from "../sanitize.ts";

const thinking = (text: string, signature = "sig"): ContentBlock => ({
  type: "thinking",
  text,
  signature,
});
const text = (value: string): ContentBlock => ({ type: "text", text: value });
const toolUse = (id: string): ContentBlock => ({ type: "tool_use", id, name: "Read", input: {} });
const toolResult = (id: string): ContentBlock => ({
  type: "tool_result",
  tool_use_id: id,
  content: "ok",
});

const isThinking = (block: ContentBlock): boolean => block.type === "thinking";
const assistants = (msgs: Message[]): Message[] => msgs.filter((m) => m.role === "assistant");

describe("sanitizeMessages thinking normalization", () => {
  it("drops an orphaned thinking-only assistant message", () => {
    const input: Message[] = [
      { role: "user", content: [text("hi")] },
      { role: "assistant", content: [thinking("stranded")] },
      { role: "user", content: [text("next")] },
    ];
    const out = sanitizeMessages(input);
    expect(assistants(out).some((m) => m.content.every(isThinking))).toBe(false);
  });

  it("strips a trailing thinking block from the last assistant message", () => {
    const input: Message[] = [
      { role: "user", content: [text("hi")] },
      { role: "assistant", content: [thinking("reasoning"), text("answer"), thinking("dangling")] },
    ];
    const out = sanitizeMessages(input);
    const last = out[out.length - 1];
    expect(last?.role).toBe("assistant");
    const tail = last?.content[last.content.length - 1];
    expect(tail && isThinking(tail)).toBe(false);
  });

  it("preserves a thinking block that precedes tool_use", () => {
    const input: Message[] = [
      { role: "assistant", content: [thinking("plan"), toolUse("t1")] },
      { role: "user", content: [toolResult("t1")] },
    ];
    const out = sanitizeMessages(input);
    const first = out[0];
    expect(first?.content[0]).toEqual(thinking("plan"));
    expect(first?.content.some((b) => b.type === "tool_use")).toBe(true);
  });

  it("preserves Anthropic tool_reference results only when requested", () => {
    const input: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "search-1", name: "ToolSearch", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "search-1",
            content: [{ type: "tool_reference", tool_name: "EnterWorktree" }],
          },
        ],
      },
    ];
    const stripped = sanitizeMessages(input);
    const preserved = sanitizeMessages(input, { preserveToolReferences: true });
    expect((stripped[1]?.content[0] as { content?: unknown }).content).toBe("");
    expect((preserved[1]?.content[0] as { content?: unknown }).content).toEqual([
      { type: "tool_reference", tool_name: "EnterWorktree" },
    ]);
  });

  it("drops a whitespace-only assistant message", () => {
    const input: Message[] = [
      { role: "user", content: [text("hi")] },
      { role: "assistant", content: [text("\n\n")] },
      { role: "user", content: [text("next")] },
    ];
    const out = sanitizeMessages(input);
    expect(assistants(out).length).toBe(0);
  });

  it("replaces an all-thinking last assistant message with a placeholder", () => {
    const input: Message[] = [
      { role: "user", content: [text("hi")] },
      { role: "assistant", content: [text("answer")] },
      { role: "user", content: [text("again")] },
      { role: "assistant", content: [thinking("only")] },
    ];
    const out = sanitizeMessages(input);
    const last = out[out.length - 1];
    expect(last?.content.some(isThinking)).toBe(false);
  });
});
