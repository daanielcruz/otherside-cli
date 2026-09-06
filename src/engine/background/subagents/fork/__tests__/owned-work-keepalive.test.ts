import { afterEach, describe, expect, test } from "bun:test";
import { hasRunningOwnedWork } from "@/engine/background/subagents/fork/loop-runner.ts";
import {
  clearAgentSteers,
  drainAgentSteers,
  queueAgentSteer,
  resetSteerEmitThrottleForTests,
  waitForAgentSteer,
} from "@/engine/background/subagents/fork/steering.ts";
import {
  completeTask,
  get as getBackgroundTask,
  setTaskParked,
  startTask,
} from "@/engine/background/tasks/background.ts";
import {
  enrollWorkflowTask,
  removeWorkflowTask,
  resetWorkflowTasksForTests,
  updateWorkflowTask,
} from "@/engine/background/workflows/runtime/store/store.ts";
import type { WorkflowTaskLifecycle } from "@/engine/background/workflows/runtime/store/types.ts";
import { emitQueue } from "@/engine/queue/emit.ts";

// The fork loop parks itself (loop-runner: waitForOwner) instead of settling
// while it still owns running background work. These tests pin the predicate
// that gates that park so a store/ownership rename cannot silently un-wire it.

const OWNER = "fork-keepalive-owner";

function runningWorkflowTask(id: string, ownerId: string): WorkflowTaskLifecycle {
  return {
    id,
    type: "local_workflow",
    status: "running",
    parentToolCallId: `tool-${id}`,
    workflowRunId: `run-${id}`,
    cwd: "/tmp",
    sessionId: "session-keepalive",
    workflowName: "keepalive",
    description: "keepalive workflow",
    ownerId,
    workflowProgress: [],
    progressVersion: 0,
    agentCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    logs: [],
    startedAt: Date.now(),
    abortController: new AbortController(),
  };
}

describe("hasRunningOwnedWork keepalive predicate", () => {
  afterEach(() => {
    resetWorkflowTasksForTests();
  });

  test("a running workflow owned by the fork keeps the owner alive", () => {
    expect(hasRunningOwnedWork(OWNER)).toBe(false);
    enrollWorkflowTask(runningWorkflowTask("wf-keepalive", OWNER));
    expect(hasRunningOwnedWork(OWNER)).toBe(true);
  });

  test("a terminal workflow no longer keeps the owner alive", () => {
    enrollWorkflowTask(runningWorkflowTask("wf-terminal", OWNER));
    updateWorkflowTask("wf-terminal", { status: "completed" });
    expect(hasRunningOwnedWork(OWNER)).toBe(false);
    removeWorkflowTask("wf-terminal");
    expect(hasRunningOwnedWork(OWNER)).toBe(false);
  });

  test("a workflow owned by a different fork does not keep this owner alive", () => {
    enrollWorkflowTask(runningWorkflowTask("wf-other", "some-other-owner"));
    expect(hasRunningOwnedWork(OWNER)).toBe(false);
  });

  test("a running backgrounded agent owned by the fork keeps the owner alive", () => {
    const task = startTask({
      parentToolCallId: "tool-bg",
      agentName: "worker",
      ownerId: OWNER,
      isBackgrounded: true,
    });
    expect(hasRunningOwnedWork(OWNER)).toBe(true);
    completeTask(task.id, { content: "done", isError: false });
    expect(hasRunningOwnedWork(OWNER)).toBe(false);
  });
});

// The park block races the owner-inventory wait against the steer wait. These
// tests pin the wake contract: either input releases the park, waking never
// claims, and each input is still delivered exactly once by its own drain.
describe("parked fork wake race", () => {
  afterEach(() => {
    resetSteerEmitThrottleForTests();
  });

  function parkRace(ownerId: string, wake: AbortController): Promise<void> {
    return Promise.race([
      emitQueue.waitForOwner(ownerId, wake.signal),
      waitForAgentSteer(ownerId, wake.signal),
    ]);
  }

  test("a queued steer wakes the park without claiming the queue", async () => {
    const ownerId = "parked-wake-steer";
    clearAgentSteers(ownerId);
    resetSteerEmitThrottleForTests();
    const wake = new AbortController();
    const parked = parkRace(ownerId, wake);
    queueAgentSteer(ownerId, { text: "wake up", blocks: [{ type: "text", text: "wake up" }] });
    await parked;
    wake.abort();
    expect(drainAgentSteers(ownerId).map((message) => message.text)).toEqual(["wake up"]);
  });

  test("a steer and an owner notification deliver exactly once each", async () => {
    const ownerId = "parked-wake-both";
    clearAgentSteers(ownerId);
    resetSteerEmitThrottleForTests();
    const release = emitQueue.registerOwner(ownerId);
    const wake = new AbortController();
    const parked = parkRace(ownerId, wake);
    queueAgentSteer(ownerId, { text: "steer", blocks: [{ type: "text", text: "steer" }] });
    emitQueue.emitForCompletion({
      class: "deferred_output",
      ownerId,
      isSubagentOwned: true,
      payload: { kind: "task_notification_xml", text: "<task-id>child</task-id>" },
      autoTurn: false,
    });
    await parked;
    wake.abort();
    // The loop's next iteration drains both inputs, each exactly once.
    expect(emitQueue.takeForOwner(ownerId)).toHaveLength(1);
    expect(emitQueue.takeForOwner(ownerId)).toHaveLength(0);
    expect(drainAgentSteers(ownerId)).toHaveLength(1);
    expect(drainAgentSteers(ownerId)).toHaveLength(0);
    release();
  });
});

describe("parked task state", () => {
  test("parking is running-only, freezes into parkedAt, and completion clears it", () => {
    const task = startTask({
      parentToolCallId: "tool-parked",
      agentName: "worker",
      ownerId: OWNER,
      isBackgrounded: true,
    });
    setTaskParked(task.id, true);
    expect(getBackgroundTask(task.id)?.parkedAt).toBeDefined();
    setTaskParked(task.id, false);
    expect(getBackgroundTask(task.id)?.parkedAt).toBeUndefined();

    setTaskParked(task.id, true);
    completeTask(task.id, { content: "done", isError: false });
    const completed = getBackgroundTask(task.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.parkedAt).toBeUndefined();

    // Terminal tasks cannot park.
    setTaskParked(task.id, true);
    expect(getBackgroundTask(task.id)?.parkedAt).toBeUndefined();
  });
});
