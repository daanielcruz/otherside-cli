import { afterEach, describe, expect, test } from "bun:test";
import { emitQueue } from "@/engine/queue/emit.ts";
import {
  clear,
  completeTask,
  get,
  reopenTask,
  setEvictionDelayForTests,
  startTask,
} from "../background.ts";

const DEFAULT_EVICTION_DELAY_MS = 30_000;

afterEach(() => {
  clear();
  emitQueue._resetForTests();
  setEvictionDelayForTests(DEFAULT_EVICTION_DELAY_MS);
});

describe("background task resume", () => {
  test("claims a completed task only once", () => {
    const task = startTask({ parentToolCallId: "call-race", agentName: "general-purpose" });
    completeTask(task.id, { content: "done", isError: false });

    const resumed = reopenTask(task.id);
    expect(resumed?.status).toBe("running");
    expect(resumed?.runGeneration).toBe(1);
    expect(reopenTask(task.id)).toBeUndefined();
  });

  test("emits one completion notification per run generation", () => {
    const task = startTask({
      parentToolCallId: "call-notify",
      agentName: "general-purpose",
      isBackgrounded: true,
    });

    completeTask(task.id, { content: "first", isError: false });
    expect(reopenTask(task.id)?.runGeneration).toBe(1);
    completeTask(task.id, { content: "second", isError: false });

    const keys = emitQueue
      .peek({ class: "deferred_output" })
      .map((item) => item.replayKey)
      .filter((key) => key?.startsWith(`bg:${task.id}:`));
    expect(keys).toEqual([`bg:${task.id}:0`, `bg:${task.id}:1`]);
  });

  test("cancels the old eviction and schedules a fresh one", async () => {
    setEvictionDelayForTests(20);
    const task = startTask({ parentToolCallId: "call-1", agentName: "general-purpose" });

    completeTask(task.id, { content: "first", isError: false });
    expect(reopenTask(task.id)?.status).toBe("running");

    await Bun.sleep(30);
    expect(get(task.id)?.status).toBe("running");

    completeTask(task.id, { content: "second", isError: false });
    await Bun.sleep(30);
    expect(get(task.id)).toBeUndefined();
  });
});
