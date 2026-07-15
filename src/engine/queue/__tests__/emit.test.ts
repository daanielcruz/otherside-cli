import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { emitQueue, fireNotificationHook } from "@/engine/queue/emit.ts";
import type { NotificationCtx } from "@/kernel/hooks/events.ts";

beforeEach(() => {
  emitQueue._resetForTests();
});

afterEach(() => {
  emitQueue._resetForTests();
});

describe("emitQueue.takeForOwner", () => {
  it("consumes only inventory items of the given owner", () => {
    const release = emitQueue.registerOwner("fork_x");
    emitQueue.emitForCompletion({
      class: "deferred_output",
      ownerId: "fork_x",
      isSubagentOwned: true,
      payload: { kind: "task_notification_xml", text: "<task-id>t1</task-id>" },
      autoTurn: false,
    });
    emitQueue.emitForCompletion({
      class: "deferred_output",
      ownerId: undefined,
      isSubagentOwned: false,
      payload: { kind: "task_notification_xml", text: "<task-id>t2</task-id>" },
      autoTurn: true,
    });

    const taken = emitQueue.takeForOwner("fork_x");
    expect(taken.length).toBe(1);
    const payload = taken[0]?.payload;
    if (payload?.kind !== "task_notification_xml") throw new Error("wrong payload kind");
    expect(payload.text).toContain("t1");

    expect(emitQueue.takeForOwner("fork_x").length).toBe(0);
    expect(emitQueue.peek({ class: "deferred_output" }).length).toBe(1);
    release();
  });
});

describe("emitQueue.drainForBoundary", () => {
  it("returns an empty result and skips listeners when no items are queued", () => {
    const calls: string[] = [];
    const unsubscribe = emitQueue.onDrain((_result, boundary) => calls.push(boundary));

    const result = emitQueue.drainForBoundary("turn_start");
    unsubscribe();

    expect(result).toEqual({
      llmBlocks: [],
      transcriptEntries: [],
      consumedIds: [],
      removedQueuedMessageIds: [],
      notificationTexts: [],
    });
    expect(calls).toEqual([]);
  });

  it("does not re-enqueue consumed sticky replay keys until the next active turn", () => {
    const firstId = emitQueue.emit({
      class: "urgent_output",
      target: "llm_request",
      payload: {
        kind: "task_notification_xml",
        text: "<task-notification>one</task-notification>",
      },
      replayKey: "rk_1",
      sticky: true,
    });

    const firstDrain = emitQueue.drainForBoundary("tool_loop_end");
    expect(firstDrain.consumedIds).toEqual([firstId]);

    emitQueue.emit({
      class: "urgent_output",
      target: "llm_request",
      payload: {
        kind: "task_notification_xml",
        text: "<task-notification>two</task-notification>",
      },
      replayKey: "rk_1",
      sticky: true,
    });
    expect(emitQueue.peek()).toEqual([]);

    emitQueue.setTurnActive(true);
    const secondId = emitQueue.emit({
      class: "urgent_output",
      target: "llm_request",
      payload: {
        kind: "task_notification_xml",
        text: "<task-notification>next turn</task-notification>",
      },
      replayKey: "rk_1",
      sticky: true,
    });

    expect(emitQueue.peek().map((item) => item.id)).toEqual([secondId]);
  });

  it("keeps urgent and deferred output queued across the mid-turn boundary", () => {
    const userId = emitQueue.emit({
      class: "user_message",
      target: "llm_request",
      payload: { kind: "user_interrupt_message", text: "please pause" },
    });
    const urgentId = emitQueue.emit({
      class: "urgent_output",
      target: "llm_request",
      payload: {
        kind: "task_notification_xml",
        text: "<task-notification>urgent</task-notification>",
      },
    });
    const deferredId = emitQueue.emit({
      class: "deferred_output",
      target: "llm_request",
      payload: {
        kind: "task_notification_xml",
        text: "<task-notification>deferred</task-notification>",
      },
    });

    const midTurn = emitQueue.drainForBoundary("mid_turn");
    expect(midTurn.consumedIds).toEqual([userId]);
    expect(emitQueue.peek().map((item) => item.id)).toEqual([urgentId, deferredId]);

    const loopEnd = emitQueue.drainForBoundary("tool_loop_end");
    expect(loopEnd.consumedIds).toEqual([urgentId, deferredId]);
    expect(emitQueue.peek()).toEqual([]);
  });
});

describe("emitQueue notification hooks", () => {
  it("fires one hook when a completion drains", () => {
    const calls: NotificationCtx[] = [];
    emitQueue._setNotificationHookRunnerForTests((ctx) => calls.push(ctx));

    emitQueue.emitForCompletion({
      class: "deferred_output",
      ownerId: undefined,
      isSubagentOwned: false,
      payload: {
        kind: "task_notification_xml",
        text: "<task-notification><summary>done</summary></task-notification>",
        summary: 'Agent "sync" completed',
      },
      autoTurn: true,
    });

    expect(calls).toEqual([]);
    const result = emitQueue.drainForBoundary("turn_start");

    expect(result.notificationTexts).toEqual([
      "<task-notification><summary>done</summary></task-notification>",
    ]);
    expect(calls).toEqual([
      {
        hook_event_name: "Notification",
        message: 'Agent "sync" completed',
        notification_type: "agent_completed",
      },
    ]);

    emitQueue.drainForBoundary("turn_start");
    expect(calls).toHaveLength(1);
  });

  it("continues draining when the hook runner fails", () => {
    emitQueue._setNotificationHookRunnerForTests(() => {
      throw new Error("hook failed");
    });

    emitQueue.emitForCompletion({
      class: "urgent_output",
      ownerId: undefined,
      isSubagentOwned: false,
      payload: {
        kind: "task_notification_xml",
        text: "<task-notification><summary>failed</summary></task-notification>",
        summary: 'Agent "sync" failed',
        isError: true,
      },
      autoTurn: true,
    });

    const result = emitQueue.drainForBoundary("turn_start");

    expect(result.consumedIds).toHaveLength(1);
    expect(result.notificationTexts).toEqual([
      "<task-notification><summary>failed</summary></task-notification>",
    ]);
    expect(emitQueue.peek()).toEqual([]);
  });

  it("fireNotificationHook reuses the configured runner and swallows errors", () => {
    const calls: NotificationCtx[] = [];
    emitQueue._setNotificationHookRunnerForTests((ctx) => calls.push(ctx));

    const ctx: NotificationCtx = {
      hook_event_name: "Notification",
      message: "Otherside needs your permission to use Bash",
      notification_type: "permission_prompt",
    };
    fireNotificationHook(ctx);
    expect(calls).toEqual([ctx]);

    emitQueue._setNotificationHookRunnerForTests(() => {
      throw new Error("boom");
    });
    expect(() => fireNotificationHook(ctx)).not.toThrow();
  });
});
