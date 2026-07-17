import { beforeEach, describe, expect, test } from "bun:test";
import { emitQueue } from "@/engine/queue/emit.ts";

beforeEach(() => {
  emitQueue._resetForTests();
});

describe("boundary policy", () => {
  test("T11 mid_turn delivers deferred_output to the running model", () => {
    emitQueue.emit({
      class: "deferred_output",
      target: "both",
      payload: {
        kind: "task_notification_xml",
        text: "<task-notification>done</task-notification>",
        summary: "done",
      },
    });
    const result = emitQueue.drainForBoundary("mid_turn");
    expect(result.consumedIds.length).toBe(1);
    const block = result.llmBlocks[0];
    const text = block?.type === "text" ? block.text : "";
    expect(text).toContain("<task-notification>done</task-notification>");
    expect(result.notificationTexts).toEqual(["<task-notification>done</task-notification>"]);
    expect(emitQueue.peek({ class: "deferred_output" }).length).toBe(0);
  });

  test("T12 mid_turn drains interrupts", () => {
    emitQueue.emit({
      class: "interrupt_bash",
      target: "llm_request",
      payload: { kind: "tool_result_interrupt", toolUseId: "t1", content: "x" },
    });
    emitQueue.emit({
      class: "interrupt_agent_workflow",
      target: "llm_request",
      payload: { kind: "tool_result_interrupt", toolUseId: "a1", content: "x" },
    });
    const result = emitQueue.drainForBoundary("mid_turn");
    expect(result.consumedIds.length).toBe(2);
  });

  test("T13 tool_loop_end drains interrupts and deferred_output; user_message remains queued", () => {
    emitQueue.emit({
      class: "interrupt_bash",
      target: "llm_request",
      payload: { kind: "tool_result_interrupt", toolUseId: "t1", content: "x" },
    });
    emitQueue.emit({
      class: "deferred_output",
      target: "llm_request",
      payload: { kind: "tool_result", toolUseId: "a1", content: "x" },
    });
    emitQueue.emit({
      class: "user_message",
      target: "llm_request",
      payload: { kind: "queued_message", queuedMessageId: "q1" },
    });
    const result = emitQueue.drainForBoundary("tool_loop_end");
    expect(result.consumedIds.length).toBe(2);
    expect(emitQueue.peek({ class: "deferred_output" }).length).toBe(0);
    expect(emitQueue.peek({ class: "user_message" }).length).toBe(1);
  });

  test("T13c tool_loop_end delivers background completions mid-turn with envelope and record text", () => {
    emitQueue.emit({
      class: "deferred_output",
      target: "both",
      payload: {
        kind: "task_notification_xml",
        text: "<task-notification>done</task-notification>",
        summary: "done",
      },
    });
    const result = emitQueue.drainForBoundary("tool_loop_end");
    expect(result.consumedIds.length).toBe(1);
    expect(result.llmBlocks.length).toBe(1);
    const block = result.llmBlocks[0];
    const text = block?.type === "text" ? block.text : "";
    expect(text.startsWith("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]")).toBe(true);
    expect(text.includes("<task-notification>done</task-notification>")).toBe(true);
    expect(text.endsWith("</system-reminder>")).toBe(true);
    expect(result.notificationTexts).toEqual(["<task-notification>done</task-notification>"]);
  });

  test("T13b tool_loop_end delivers urgent_output mid-turn", () => {
    emitQueue.emit({
      class: "urgent_output",
      target: "both",
      payload: {
        kind: "task_notification_xml",
        text: "<task-notification>stalled</task-notification>",
        summary: "stalled",
      },
    });
    const result = emitQueue.drainForBoundary("tool_loop_end");
    expect(result.consumedIds.length).toBe(1);
    expect(result.llmBlocks.length).toBeGreaterThan(0);
    expect(emitQueue.peek({ class: "urgent_output" }).length).toBe(0);
  });

  test("T14 idle_prompt (scheduled wakeup) never drains mid-turn — tool_loop_end and mid_turn skip it; turn_start picks it", () => {
    // Reference parity: wakeups enqueue at priority "later"
    // (useScheduledTasks), and the mid-turn fold is capped at "next"
    // (getCommandsByMaxPriority("next")) — a wakeup must NOT interrupt a
    // running tool loop.
    emitQueue.emit({
      class: "idle_prompt",
      target: "both",
      payload: { kind: "user_interrupt_message", text: "loop wakeup" },
      autoTurn: true,
      replayKey: "loop:test-job",
    });
    const toolLoopEnd = emitQueue.drainForBoundary("tool_loop_end");
    expect(toolLoopEnd.consumedIds.length).toBe(0);
    const midTurn = emitQueue.drainForBoundary("mid_turn");
    expect(midTurn.consumedIds.length).toBe(0);
    expect(emitQueue.peek({ class: "idle_prompt" }).length).toBe(1);
    // Still advertises a pending auto-turn so an idle session wakes.
    expect(emitQueue.hasPendingAutoTurn()).toBe(true);
    const turnStart = emitQueue.setTurnActive(true);
    expect(turnStart).not.toBeNull();
    expect(turnStart?.consumedIds.length).toBe(1);
    const block = turnStart?.llmBlocks[0];
    expect(block?.type === "text" ? block.text : "").toBe("loop wakeup");
    expect(emitQueue.peek({ class: "idle_prompt" }).length).toBe(0);
  });

  test("T13d turn_start delivers notifications as plain prefixed text (no reminder envelope)", () => {
    emitQueue.emit({
      class: "deferred_output",
      target: "both",
      payload: {
        kind: "task_notification_xml",
        text: "<task-notification>fresh</task-notification>",
        summary: "fresh",
      },
    });
    const result = emitQueue.setTurnActive(true);
    expect(result).not.toBeNull();
    const block = result?.llmBlocks[0];
    const text = block?.type === "text" ? block.text : "";
    expect(text.startsWith("[SYSTEM NOTIFICATION - NOT USER INPUT]")).toBe(true);
    expect(text).toContain("No human input has been received");
    expect(text).not.toContain("<system-reminder>");
    expect(text.endsWith("<task-notification>fresh</task-notification>")).toBe(true);
  });

  test("T15 a stop-hook rewake item marks its consuming drain stopHookActive", () => {
    emitQueue.emit({
      class: "urgent_output",
      target: "both",
      payload: { kind: "task_notification_xml", text: "<task-notification/>", summary: "rewake" },
      autoTurn: true,
      stopHookActive: true,
    });
    const result = emitQueue.setTurnActive(true);
    expect(result?.stopHookActive).toBe(true);
    emitQueue.setTurnActive(false);
    emitQueue.emit({
      class: "deferred_output",
      target: "both",
      payload: { kind: "task_notification_xml", text: "<task-notification/>", summary: "plain" },
    });
    const plain = emitQueue.setTurnActive(true);
    expect(plain?.stopHookActive).toBeUndefined();
  });

  test("T16 turn_start drains items that arrived during idle", () => {
    emitQueue.emit({
      class: "deferred_output",
      target: "both",
      payload: { kind: "tool_result", toolUseId: "a1", content: "x" },
    });
    const result = emitQueue.setTurnActive(true);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.consumedIds.length).toBe(1);
  });
});
