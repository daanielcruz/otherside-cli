import { describe, expect, it } from "bun:test";
import {
  computeInterruptionResult,
  computeRestoreUnansweredResult,
  type InterruptionSnapshot,
  type RestoreUnansweredSnapshot,
} from "@/engine/queue/runtime/cancellation.ts";
import {
  INTERRUPT_MESSAGE,
  TOOL_INTERRUPT_MESSAGE,
} from "@/engine/queue/runtime/interruption-text.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";

function baseSnapshot(overrides: Partial<InterruptionSnapshot> = {}): InterruptionSnapshot {
  return {
    entries: [],
    partialText: "",
    committedLen: 0,
    streamingId: null,
    currentTurnUserId: null,
    showFeedback: true,
    conversationMarker: false,
    partialIdFallback: "p0",
    interruptId: "i0",
    provider: "anthropic",
    model: "claude-opus",
    nowIso: "2026-06-19T00:00:00.000Z",
    ...overrides,
  };
}

function baseRestoreSnapshot(
  overrides: Partial<RestoreUnansweredSnapshot> = {},
): RestoreUnansweredSnapshot {
  return {
    turnHadVisibleOutput: false,
    streamingTextLength: 0,
    entries: [],
    promptTextLength: 0,
    queueLength: 0,
    currentTurnUserId: null,
    currentTurnPrompt: null,
    ...overrides,
  };
}

describe("computeInterruptionResult", () => {
  it("empty snapshot emits NO assistant/user records, no feedback entry", () => {
    const result = computeInterruptionResult(baseSnapshot());
    expect(result.nextEntries.length).toBe(0);
    expect(result.assistantMessageToPush).toBeNull();
    expect(result.userMessageToPush).toBeNull();
    expect(result.assistantRecordToAppend).toBeNull();
    expect(result.userRecordToAppend).toBeNull();
  });

  it("partial text + no open tool emits assistant message+record", () => {
    const snapshot = baseSnapshot({
      partialText: "hello world",
      streamingId: "a_0_0",
      currentTurnUserId: "u_0",
      conversationMarker: true,
    });
    const result = computeInterruptionResult(snapshot);
    expect(result.assistantMessageToPush).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "hello world" }],
    });
    expect(result.assistantRecordToAppend).toMatchObject({
      type: "assistant_message",
      content: "hello world",
      provider: "anthropic",
      model: "claude-opus",
    });
    expect(result.userMessageToPush).toEqual({
      role: "user",
      content: [{ type: "text", text: INTERRUPT_MESSAGE }],
    });
  });

  it("open tool blocks assistant emission AND user feedback", () => {
    const openTool: TranscriptEntry = {
      id: "t_42",
      kind: "tool",
      title: "Read",
      text: "running…",
    };
    const snapshot = baseSnapshot({
      entries: [openTool],
      partialText: "partial",
      streamingId: "a_0_0",
      currentTurnUserId: "u_0",
      conversationMarker: true,
    });
    const result = computeInterruptionResult(snapshot);
    expect(result.assistantMessageToPush).toBeNull();
    expect(result.userMessageToPush).toBeNull();
    expect(result.nextEntries[0]).toMatchObject({
      id: "r_42",
      kind: "tool",
      text: TOOL_INTERRUPT_MESSAGE,
      isError: true,
    });
  });

  it("clamps committedLen to partialText bounds — fully-committed text emits NO partial entry", () => {
    const snapshot = baseSnapshot({
      partialText: "ab",
      committedLen: 999,
      streamingId: "a_0_0",
      currentTurnUserId: "u_0",
    });
    const result = computeInterruptionResult(snapshot);
    expect(result.nextEntries.some((e) => e.kind === "assistant")).toBe(false);
    expect(result.assistantMessageToPush).not.toBeNull();
  });

  it("continuation flag set when committedLen > 0", () => {
    const snapshot = baseSnapshot({
      partialText: "hello world",
      committedLen: 5,
      streamingId: "a_0_0",
      currentTurnUserId: "u_0",
    });
    const result = computeInterruptionResult(snapshot);
    const assistantEntry = result.nextEntries.find((e) => e.kind === "assistant");
    expect(assistantEntry?.continuation).toBe(true);
    expect(assistantEntry?.text).toBe(" world");
  });

  it("showFeedback=false suppresses interrupt-feedback entry", () => {
    const snapshot = baseSnapshot({
      partialText: "x",
      streamingId: "a_0_0",
      currentTurnUserId: "u_0",
      showFeedback: false,
      conversationMarker: true,
    });
    const result = computeInterruptionResult(snapshot);
    expect(result.nextEntries.some((e) => e.kind === "system")).toBe(false);
    expect(result.userMessageToPush).toBeNull();
  });
});

describe("computeRestoreUnansweredResult", () => {
  it("turn with visible output cannot be restored", () => {
    const result = computeRestoreUnansweredResult(
      baseRestoreSnapshot({ turnHadVisibleOutput: true }),
    );
    expect(result.shouldRestore).toBe(false);
  });

  it("streaming text already received cannot be restored", () => {
    const result = computeRestoreUnansweredResult(baseRestoreSnapshot({ streamingTextLength: 12 }));
    expect(result.shouldRestore).toBe(false);
  });

  it("queue messages present block restore", () => {
    const result = computeRestoreUnansweredResult(baseRestoreSnapshot({ queueLength: 1 }));
    expect(result.shouldRestore).toBe(false);
  });

  it("prompt already populated blocks restore", () => {
    const result = computeRestoreUnansweredResult(baseRestoreSnapshot({ promptTextLength: 3 }));
    expect(result.shouldRestore).toBe(false);
  });

  it("missing userId or prompt blocks restore", () => {
    const a = computeRestoreUnansweredResult(
      baseRestoreSnapshot({ currentTurnUserId: null, currentTurnPrompt: "x" }),
    );
    const b = computeRestoreUnansweredResult(
      baseRestoreSnapshot({ currentTurnUserId: "u", currentTurnPrompt: null }),
    );
    expect(a.shouldRestore).toBe(false);
    expect(b.shouldRestore).toBe(false);
  });

  it("clean snapshot with userId + prompt restores", () => {
    const result = computeRestoreUnansweredResult(
      baseRestoreSnapshot({
        currentTurnUserId: "u_5",
        currentTurnPrompt: "what is 2+2?",
      }),
    );
    expect(result.shouldRestore).toBe(true);
    if (result.shouldRestore) {
      expect(result.userIdToRemove).toBe("u_5");
      expect(result.promptToRestore).toBe("what is 2+2?");
      expect(result.resetRenderSurface).toBe(true);
    }
  });

  it("resetRenderSurface=false when last entry is the in-flight user echo", () => {
    const inFlightUser: TranscriptEntry = { id: "u_5", kind: "user", text: "hi" };
    const result = computeRestoreUnansweredResult(
      baseRestoreSnapshot({
        currentTurnUserId: "u_5",
        currentTurnPrompt: "hi",
        entries: [inFlightUser],
      }),
    );
    expect(result.shouldRestore).toBe(true);
    if (result.shouldRestore) {
      expect(result.resetRenderSurface).toBe(false);
    }
  });

  it("open tool entry blocks restore", () => {
    const openTool: TranscriptEntry = { id: "t_1", kind: "tool", text: "running…" };
    const result = computeRestoreUnansweredResult(
      baseRestoreSnapshot({
        currentTurnUserId: "u",
        currentTurnPrompt: "go",
        entries: [openTool],
      }),
    );
    expect(result.shouldRestore).toBe(false);
  });
});
