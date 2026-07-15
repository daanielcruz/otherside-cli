import { afterEach, describe, expect, test } from "bun:test";
import { hasRunningOwnedWork } from "@/engine/background/subagents/fork/loop-runner.ts";
import { completeTask, startTask } from "@/engine/background/tasks/background.ts";
import {
  registerWorkflowTask,
  removeWorkflowTask,
  resetWorkflowTasksForTests,
  updateWorkflowTask,
} from "@/engine/background/workflows/runtime/store/store.ts";
import type { LocalWorkflowTaskState } from "@/engine/background/workflows/runtime/store/types.ts";

// The fork loop parks itself (loop-runner: waitForOwner) instead of settling
// while it still owns running background work. These tests pin the predicate
// that gates that park so a store/ownership rename cannot silently un-wire it.

const OWNER = "fork-keepalive-owner";

function runningWorkflowTask(id: string, ownerId: string): LocalWorkflowTaskState {
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
    registerWorkflowTask(runningWorkflowTask("wf-keepalive", OWNER));
    expect(hasRunningOwnedWork(OWNER)).toBe(true);
  });

  test("a terminal workflow no longer keeps the owner alive", () => {
    registerWorkflowTask(runningWorkflowTask("wf-terminal", OWNER));
    updateWorkflowTask("wf-terminal", { status: "completed" });
    expect(hasRunningOwnedWork(OWNER)).toBe(false);
    removeWorkflowTask("wf-terminal");
    expect(hasRunningOwnedWork(OWNER)).toBe(false);
  });

  test("a workflow owned by a different fork does not keep this owner alive", () => {
    registerWorkflowTask(runningWorkflowTask("wf-other", "some-other-owner"));
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
