import { beforeEach, describe, expect, test } from "bun:test";
import { emitQueue } from "@/engine/queue/emit.ts";
import { PRIORITY_ORDER } from "@/engine/queue/priority.ts";

beforeEach(() => {
  emitQueue._resetForTests();
});

describe("PRIORITY_ORDER owner lock", () => {
  test("T01 priority order matches canonical lock", () => {
    expect(PRIORITY_ORDER).toEqual([
      "interrupt_agent_workflow",
      "interrupt_bash",
      "user_message",
      "urgent_output",
      "deferred_output",
      "idle_prompt",
    ]);
  });
});

describe("replayKey semantics", () => {
  test("T02 intra-class splice-replace uses NEW item (last-wins)", () => {
    emitQueue.emit({
      class: "deferred_output",
      target: "llm_request",
      payload: { kind: "tool_result", toolUseId: "call_1", content: "first" },
      replayKey: "key1",
    });
    emitQueue.emit({
      class: "deferred_output",
      target: "llm_request",
      payload: { kind: "tool_result", toolUseId: "call_1", content: "second" },
      replayKey: "key1",
    });
    const peeked = emitQueue.peek({ class: "deferred_output" });
    expect(peeked.length).toBe(1);
    const first = peeked[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect((first.payload as { content: string }).content).toBe("second");
  });

  test("T03 sticky replayKey blocks re-enqueue after commit; non-sticky does not", () => {
    emitQueue.emit({
      class: "interrupt_bash",
      target: "llm_request",
      payload: { kind: "tool_result_interrupt", toolUseId: "t1", content: "x" },
      replayKey: "bash-int:t1",
      sticky: true,
    });
    emitQueue.drainForBoundary("tool_loop_end");
    expect(emitQueue.peek({ class: "interrupt_bash" }).length).toBe(0);
    emitQueue.emit({
      class: "interrupt_bash",
      target: "llm_request",
      payload: { kind: "tool_result_interrupt", toolUseId: "t1", content: "x" },
      replayKey: "bash-int:t1",
      sticky: true,
    });
    expect(emitQueue.peek({ class: "interrupt_bash" }).length).toBe(0);

    emitQueue.emit({
      class: "deferred_output",
      target: "llm_request",
      payload: { kind: "tool_result", toolUseId: "a1", content: "x" },
      replayKey: "agent:fork1",
    });
    emitQueue.drainForBoundary("turn_start");
    emitQueue.emit({
      class: "deferred_output",
      target: "llm_request",
      payload: { kind: "tool_result", toolUseId: "a1", content: "x" },
      replayKey: "agent:fork1",
    });
    expect(emitQueue.peek({ class: "deferred_output" }).length).toBe(1);
  });
});

describe("popMatching tri-phase and target filter", () => {
  test("T05 target=transcript item NOT consumed at LLM-only boundary", () => {
    emitQueue.emit({
      class: "interrupt_bash",
      target: "transcript",
      payload: { kind: "tool_result_interrupt", toolUseId: "t1", content: "x" },
    });
    const result = emitQueue.drainForBoundary("tool_loop_end");
    expect(result.consumedIds.length).toBe(0);
    expect(emitQueue.peek({ class: "interrupt_bash" }).length).toBe(1);
  });
});

describe("awaiter does NOT short-circuit before boundary", () => {
  test("T06 enqueue does not preempt awaiter; only drain delivers", async () => {
    const ctrl = new AbortController();
    const pending = emitQueue.awaitFirst(
      { class: "deferred_output", ownerId: "owner1" },
      ctrl.signal,
    );
    emitQueue.emit({
      class: "deferred_output",
      target: "llm_request",
      payload: { kind: "tool_result", toolUseId: "a1", content: "v" },
      ownerId: "owner1",
    });
    expect(emitQueue.peek({ class: "deferred_output" }).length).toBe(1);
    emitQueue.drainForBoundary("turn_start");
    const got = await pending;
    expect(got.ownerId).toBe("owner1");
  });
});

describe("cancel(predicate, reason)", () => {
  test("T07 cancel only removes matching; background-owned survives /clear", () => {
    emitQueue.emit({
      class: "user_message",
      target: "llm_request",
      payload: { kind: "queued_message", queuedMessageId: "q1" },
    });
    emitQueue.emit({
      class: "interrupt_agent_workflow",
      target: "both",
      payload: { kind: "queued_message", queuedMessageId: "q2" },
    });
    emitQueue.emit({
      class: "deferred_output",
      target: "both",
      payload: { kind: "tool_result", toolUseId: "a1", content: "x" },
    });
    const cancelled = emitQueue.cancel(
      (item) => item.class === "user_message" || item.class === "interrupt_agent_workflow",
      "slash_clear",
    );
    expect(cancelled.cancelledIds.length).toBe(2);
    expect(emitQueue.peek({ class: "user_message" }).length).toBe(0);
    expect(emitQueue.peek({ class: "interrupt_agent_workflow" }).length).toBe(0);
    expect(emitQueue.peek({ class: "deferred_output" }).length).toBe(1);
  });
});

describe("emitForCompletion handles subagentOwnerId", () => {
  test("T08 subagent-owned completion emits target=inventory while owner is active", () => {
    const release = emitQueue.registerOwner("parent_call_1");
    emitQueue.emitForCompletion({
      class: "deferred_output",
      ownerId: "parent_call_1",
      isSubagentOwned: true,
      payload: { kind: "task_notification_xml", text: "<task-notification/>" },
      replayKey: "bg:task1",
    });
    const peeked = emitQueue.peek({ class: "deferred_output" });
    expect(peeked.length).toBe(1);
    const first = peeked[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(first.target).toBe("inventory");
    const drain = emitQueue.drainForBoundary("turn_start");
    expect(drain.llmBlocks.length).toBe(0);
    expect(drain.transcriptEntries.length).toBe(0);
    release();
  });

  test("T08a wakes an owner as soon as its inventory receives a completion", async () => {
    const release = emitQueue.registerOwner("parent_call_2");
    const wake = emitQueue.waitForOwner("parent_call_2");
    emitQueue.emitForCompletion({
      class: "urgent_output",
      ownerId: "parent_call_2",
      isSubagentOwned: true,
      payload: { kind: "task_notification_xml", text: "<task-notification/>" },
    });

    await wake;

    expect(emitQueue.takeForOwner("parent_call_2")).toHaveLength(1);
    release();
  });

  test("T08b non-subagent completion emits target=both", () => {
    emitQueue.emitForCompletion({
      class: "urgent_output",
      ownerId: undefined,
      isSubagentOwned: false,
      payload: { kind: "task_notification_xml", text: "x", summary: "summary" },
      replayKey: "wf:1",
    });
    const peeked = emitQueue.peek({ class: "urgent_output" });
    const first = peeked[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(first.target).toBe("both");
  });
});

describe("setTurnActive clears consumedStickyKeys idempotently", () => {
  test("T09 setTurnActive(true) clears stickies even when already active is no-op", () => {
    emitQueue.emit({
      class: "interrupt_bash",
      target: "llm_request",
      payload: { kind: "tool_result_interrupt", toolUseId: "t1", content: "x" },
      replayKey: "bash-int:t1",
      sticky: true,
    });
    emitQueue.drainForBoundary("tool_loop_end");
    emitQueue.setTurnActive(true);
    emitQueue.emit({
      class: "interrupt_bash",
      target: "llm_request",
      payload: { kind: "tool_result_interrupt", toolUseId: "t1", content: "x" },
      replayKey: "bash-int:t1",
      sticky: true,
    });
    expect(emitQueue.peek({ class: "interrupt_bash" }).length).toBe(1);
  });
});

describe("fuzz no-drop invariant", () => {
  test("T10 1000 emits + random drains: count_in === committed + queued", () => {
    const boundaries: ("turn_start" | "tool_loop_end" | "mid_turn")[] = [
      "turn_start",
      "tool_loop_end",
      "mid_turn",
    ];
    let emitted = 0;
    let committed = 0;
    for (let i = 0; i < 1000; i += 1) {
      const klass = PRIORITY_ORDER[i % PRIORITY_ORDER.length];
      if (klass === undefined) continue;
      emitQueue.emit({
        class: klass,
        target: "both",
        payload: { kind: "tool_result", toolUseId: `t_${i}`, content: "x" },
      });
      emitted += 1;
      if (i % 7 === 0) {
        const b = boundaries[(i / 7) % boundaries.length];
        if (b === undefined) continue;
        const r = emitQueue.drainForBoundary(b);
        committed += r.consumedIds.length;
      }
    }
    let queued = 0;
    for (const klass of PRIORITY_ORDER) queued += emitQueue.peek({ class: klass }).length;
    expect(emitted).toBe(committed + queued);
  });
});
