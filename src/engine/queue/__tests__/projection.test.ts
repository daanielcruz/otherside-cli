import { beforeEach, describe, expect, test } from "bun:test";
import { emitQueue } from "@/engine/queue/emit.ts";
import type { QueuedMessageView } from "@/engine/queue/priority.ts";

const messages = new Map<string, QueuedMessageView>();

beforeEach(() => {
  emitQueue._resetForTests();
  messages.clear();
  emitQueue.setQueuedMessageLookup((id) => messages.get(id));
});

describe("projection", () => {
  test("T17 mid_turn with queued_message prepends system-reminder at index 0", () => {
    messages.set("q1", { id: "q1", expanded: "hello" });
    emitQueue.emit({
      class: "user_message",
      target: "llm_request",
      payload: { kind: "queued_message", queuedMessageId: "q1" },
    });
    const result = emitQueue.drainForBoundary("mid_turn");
    expect(result.llmBlocks.length).toBe(2);
    const first = result.llmBlocks[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(first.type).toBe("text");
    if (first.type !== "text") return;
    expect(first.text).toContain("<system-reminder>");
  });

  test("T18 target=both produces parallel llmBlocks + transcriptEntries in one drain", () => {
    messages.set("q1", { id: "q1", expanded: "hi" });
    emitQueue.emit({
      class: "user_message",
      target: "both",
      payload: { kind: "queued_message", queuedMessageId: "q1" },
    });
    const result = emitQueue.drainForBoundary("turn_start");
    expect(result.llmBlocks.length).toBeGreaterThan(0);
    expect(result.transcriptEntries.length).toBe(1);
  });

  test("T20 queued_message projector reports removed id after commit", () => {
    messages.set("q1", { id: "q1", expanded: "x" });
    emitQueue.emit({
      class: "user_message",
      target: "llm_request",
      payload: { kind: "queued_message", queuedMessageId: "q1" },
    });
    const result = emitQueue.drainForBoundary("mid_turn");
    expect(result.removedQueuedMessageIds).toContain("q1");
    expect(emitQueue.peek({ class: "user_message" }).length).toBe(0);
  });
});
