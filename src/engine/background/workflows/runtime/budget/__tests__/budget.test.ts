import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkflowBudget,
  createWorkflowTokenMeter,
} from "@/engine/background/workflows/runtime/budget/budget.ts";
import { persistWorkflowRun } from "@/engine/background/workflows/runtime/history/snapshot.ts";
import { launchWorkflow } from "@/engine/background/workflows/runtime/launch/launcher.ts";
import {
  getWorkflowTask,
  resetWorkflowTasksForTests,
} from "@/engine/background/workflows/runtime/store/store.ts";
import type { LocalWorkflowTaskState } from "@/engine/background/workflows/runtime/store/types.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

describe("createWorkflowTokenMeter and createWorkflowBudget", () => {
  test("seeds spent tokens and updates remaining budget", () => {
    const meter = createWorkflowTokenMeter(250);
    const budget = createWorkflowBudget({ total: 1000, meter });

    expect(meter.spent()).toBe(250);
    expect(budget.spent()).toBe(250);
    expect(budget.remaining()).toBe(750);

    meter.add(125);
    expect(meter.spent()).toBe(375);
    expect(budget.spent()).toBe(375);
    expect(budget.remaining()).toBe(625);
  });

  test("negative, NaN, and Infinity seeds normalize to 0", () => {
    const negativeMeter = createWorkflowTokenMeter(-50);
    expect(negativeMeter.spent()).toBe(0);

    const nanMeter = createWorkflowTokenMeter(Number.NaN);
    expect(nanMeter.spent()).toBe(0);

    const infinityMeter = createWorkflowTokenMeter(Number.POSITIVE_INFINITY);
    expect(infinityMeter.spent()).toBe(0);

    const negInfinityMeter = createWorkflowTokenMeter(Number.NEGATIVE_INFINITY);
    expect(negInfinityMeter.spent()).toBe(0);

    const undefinedMeter = createWorkflowTokenMeter(undefined);
    expect(undefinedMeter.spent()).toBe(0);

    const stringMeter = createWorkflowTokenMeter("250" as unknown as number);
    expect(stringMeter.spent()).toBe(0);
  });

  test("seeds a resumed VM budget from persisted total tokens", async () => {
    const cwd = join(tmpdir(), `otherside-test-resume-${randomUUID()}`);
    const sessionId = "session-resume-test";
    const runId = `wf_test-resume-${randomUUID().slice(0, 8)}`;

    const script = `export const meta = {
  name: "test-budget",
  description: "test budget script",
};
return { spent: budget.spent(), remaining: budget.remaining() };
`;

    const initialTask: LocalWorkflowTaskState = {
      id: "w_initial",
      type: "local_workflow",
      status: "completed",
      parentToolCallId: "tool-1",
      workflowRunId: runId,
      cwd,
      sessionId,
      workflowName: "test-budget",
      description: "test budget script",
      script,
      args: { tokenBudget: 1000 },
      summary: "Completed initial run",
      workflowProgress: [],
      progressVersion: 1,
      agentCount: 0,
      totalTokens: 250,
      totalToolCalls: 0,
      logs: [],
      startedAt: Date.now(),
      abortController: new AbortController(),
      agentControllers: new Map(),
    };

    await persistWorkflowRun({ cwd, sessionId, runId, task: initialTask });

    resetWorkflowTasksForTests();

    const ctx: RequestContext = {
      cwd,
      sessionId,
      provider: "anthropic",
      model: "claude-opus-4-8",
      effort: null,
      permissionMode: "default",
      abortSignal: new AbortController().signal,
    };

    const outcome = await launchWorkflow(
      {
        resumeFromRunId: runId,
        args: { tokenBudget: 1000 },
      },
      ctx,
      "tool-parent-1",
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const taskId = outcome.result.taskId;

    const launchedTask = getWorkflowTask(taskId);
    expect(launchedTask).toBeDefined();
    expect(launchedTask?.totalTokens).toBe(250);

    let currentTask = getWorkflowTask(taskId);
    const deadline = Date.now() + 5000;
    while (currentTask && currentTask.status === "running" && Date.now() < deadline) {
      await Bun.sleep(10);
      currentTask = getWorkflowTask(taskId);
    }

    expect(currentTask?.status).toBe("completed");
    expect(currentTask?.result).toEqual({ spent: 250, remaining: 750 });

    await rm(cwd, { recursive: true, force: true });
    resetWorkflowTasksForTests();
  });
});
