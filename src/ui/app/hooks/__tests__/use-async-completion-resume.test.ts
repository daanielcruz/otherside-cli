import { describe, expect, it } from "bun:test";
import type { BackgroundTask } from "@/engine/background/tasks/background.ts";
import type { LocalWorkflowTaskState } from "@/engine/background/workflows/runtime/store/types.ts";
import {
  backgroundTaskNoticeData,
  backgroundTaskNoticeIdentity,
  recordBackgroundTaskTransition,
  workflowTaskNoticeData,
} from "@/ui/app/hooks/use-async-completion-resume.ts";

describe("background completion notice transitions", () => {
  it("renders each completed generation once", () => {
    const transitionedTasks = new Set<string>();
    const notices: string[] = [];
    const appendNotice = (taskId: string, runGeneration: number): void => {
      const replayKey = backgroundTaskNoticeIdentity(taskId, runGeneration);
      if (!recordBackgroundTaskTransition(transitionedTasks, replayKey)) return;
      notices.push(`n_${replayKey}`);
    };

    appendNotice("task-1", 0);
    appendNotice("task-1", 1);
    appendNotice("task-1", 1);

    expect(notices).toEqual(["n_bg:task-1:0", "n_bg:task-1:1"]);
  });

  it("serializes agent and workflow causes without treating shell output as an error", () => {
    const base = {
      id: "task-1",
      agentName: "worker",
      description: "failure check",
      status: "error",
      startedAt: 100,
      endedAt: 200,
    };
    const agent = backgroundTaskNoticeData({
      ...base,
      kind: "agent",
      error: "classified provider failure",
    } as BackgroundTask);
    const shell = backgroundTaskNoticeData({
      ...base,
      kind: "shell",
      exitCode: 7,
      error: "command output",
    } as BackgroundTask);
    const workflow = workflowTaskNoticeData({
      ...base,
      workflowName: "failure-workflow",
      error: "invalid model pin",
    } as unknown as LocalWorkflowTaskState);

    expect(agent.error).toBe("classified provider failure");
    expect(shell.exitCode).toBe(7);
    expect(shell.error).toBeUndefined();
    expect(workflow.error).toBe("invalid model pin");
  });
});
