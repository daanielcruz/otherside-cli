import { afterEach, describe, expect, it } from "bun:test";
import { recordWorkflowAgentEvent } from "@/engine/background/workflows/runtime/launch/progress.ts";
import {
  enrollWorkflowTask,
  getWorkflowTask,
  resetWorkflowTasksForTests,
} from "@/engine/background/workflows/runtime/store/store.ts";
import type {
  WorkflowAgentStatus,
  WorkflowTaskLifecycle,
} from "@/engine/background/workflows/runtime/store/types.ts";

const TASK_ID = "task-queued";

function enrollRunningTask(): void {
  const task: WorkflowTaskLifecycle = {
    id: TASK_ID,
    type: "local_workflow",
    status: "running",
    parentToolCallId: "tool-1",
    workflowRunId: "run-1",
    cwd: "/tmp",
    sessionId: "session-1",
    workflowName: "test",
    description: "test description",
    workflowProgress: [],
    progressVersion: 0,
    agentCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    logs: [],
    startedAt: 0,
    abortController: new AbortController(),
  };
  enrollWorkflowTask(task);
}

function agentEntry(): WorkflowAgentStatus | undefined {
  const entry = getWorkflowTask(TASK_ID)?.workflowProgress.find(
    (item) => item.type === "workflow_agent",
  );
  return entry?.type === "workflow_agent" ? entry : undefined;
}

afterEach(() => {
  resetWorkflowTasksForTests();
});

describe("an agent waiting for a concurrency slot", () => {
  it("is recorded with no start time, so its row cannot read as running", () => {
    enrollRunningTask();

    recordWorkflowAgentEvent(TASK_ID, {
      index: 1,
      label: "auditor",
      state: "start",
      queued: true,
    });

    const entry = agentEntry();
    expect(entry?.startedAt).toBeUndefined();
    expect(entry?.queuedAt).toBeGreaterThan(0);
  });

  it("takes a start time the moment a slot frees, keeping the queue time it waited", () => {
    enrollRunningTask();

    recordWorkflowAgentEvent(TASK_ID, {
      index: 1,
      label: "auditor",
      state: "start",
      queued: true,
    });
    const queuedAt = agentEntry()?.queuedAt;
    recordWorkflowAgentEvent(TASK_ID, { index: 1, label: "auditor", state: "start" });

    const entry = agentEntry();
    expect(entry?.startedAt).toBeGreaterThan(0);
    // The wait is still readable after the agent starts: the queue stamp survives.
    expect(entry?.queuedAt).toBe(queuedAt);
  });

  it("counts once in the agent tally even though it is announced twice", () => {
    enrollRunningTask();

    recordWorkflowAgentEvent(TASK_ID, {
      index: 1,
      label: "auditor",
      state: "start",
      queued: true,
    });
    recordWorkflowAgentEvent(TASK_ID, { index: 1, label: "auditor", state: "start" });

    expect(getWorkflowTask(TASK_ID)?.agentCount).toBe(1);
  });
});
