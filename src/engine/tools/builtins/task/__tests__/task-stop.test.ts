import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as bgTasks from "@/engine/background/tasks/background.ts";
import * as bgControllers from "@/engine/background/tasks/background-controllers.ts";
import { clearAll as clearPlanningTasks, create } from "@/engine/background/tasks/index.ts";
import {
  enrollWorkflowTask,
  getWorkflowTask,
  resetWorkflowTasksForTests,
} from "@/engine/background/workflows/runtime/store/store.ts";
import type { WorkflowTaskLifecycle } from "@/engine/background/workflows/runtime/store/types.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import {
  type BackgroundShell,
  newShellStreams,
  SHELLS,
} from "@/engine/tools/builtins/background.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { TaskOutput, TaskStop } from "../task-control.ts";

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    provider: "anthropic",
    model: "test-model",
    effort: null,
    permissionMode: "default",
    sessionId: "session-1",
    cwd: "/tmp",
    ...overrides,
  };
}

function makeRunningWorkflowTask(id: string, cwd: string): WorkflowTaskLifecycle {
  return {
    id,
    type: "local_workflow",
    status: "running",
    parentToolCallId: `tool-${id}`,
    workflowRunId: `run-${id}`,
    cwd,
    sessionId: "session-1",
    workflowName: "test",
    description: "test workflow",
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

describe("runtime task control tools", () => {
  let tempCwd: string;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    tempCwd = mkdtempSync(join(tmpdir(), "otherside-taskstop-test-"));
    savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = join(tempCwd, "config");
    clearPlanningTasks();
    bgTasks.clear();
    bgControllers._resetForTests();
    SHELLS.clear();
  });

  afterEach(() => {
    resetWorkflowTasksForTests();
    emitQueue._resetForTests();
    clearPlanningTasks();
    bgTasks.clear();
    bgControllers._resetForTests();
    SHELLS.clear();
    if (savedConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
    rmSync(tempCwd, { recursive: true, force: true });
  });

  test("a model-invoked TaskStop does not mark the workflow stoppedByUser, and the notification still wakes an idle turn", async () => {
    enrollWorkflowTask(makeRunningWorkflowTask("wf-taskstop", tempCwd));

    const result = await TaskStop.run(
      { id: "call-1", name: "TaskStop", input: { task_id: "wf-taskstop" } },
      makeCtx({ cwd: tempCwd }),
    );

    expect(result.is_error).not.toBe(true);
    const task = getWorkflowTask("wf-taskstop");
    expect(task?.status).toBe("killed");
    expect(task?.stoppedByUser).toBeUndefined();

    const item = emitQueue
      .peek({ class: "urgent_output" })
      .find((entry) => entry.replayKey === "wf:wf-taskstop");
    expect(item).toBeDefined();
    expect(item?.autoTurn).not.toBe(false);
    const summary =
      item?.payload.kind === "task_notification_xml" ? item.payload.summary : undefined;
    expect(summary).not.toContain("by the user");
    expect(emitQueue.hasPendingAutoTurn()).toBe(true);
  });

  test("TaskStop invokes the explicit background shell terminator", async () => {
    const shellId = "b-test-shell";
    let terminateCalls = 0;
    const shell: BackgroundShell = {
      id: shellId,
      command: "sleep 60",
      startedAt: Date.now(),
      ...newShellStreams(shellId),
      status: "running",
      exitCode: null,
      child: {} as BackgroundShell["child"],
      terminate: () => {
        terminateCalls++;
      },
    };
    SHELLS.set(shellId, shell);
    bgTasks.startShellTask({
      shellId,
      command: shell.command,
      parentToolCallId: "bash-call",
    });

    const result = await TaskStop.run(
      { id: "stop-call", name: "TaskStop", input: { task_id: shellId } },
      makeCtx(),
    );

    expect(result.is_error).not.toBe(true);
    expect(terminateCalls).toBe(1);
    expect(bgTasks.get(shellId)?.status).toBe("killed");
    expect(SHELLS.has(shellId)).toBe(false);
  });

  test("TaskStop rejects an already completed runtime task", async () => {
    const task = bgTasks.startTask({
      parentToolCallId: "agent-call",
      agentName: "completed-agent",
    });
    bgTasks.completeTask(task.id, { content: "done", isError: false });

    const result = await TaskStop.run(
      { id: "stop-call", name: "TaskStop", input: { task_id: task.id } },
      makeCtx(),
    );

    expect(result.is_error).toBe(true);
    expect(String(result.content)).toBe(`Task ${task.id} is not running (status: completed)`);
  });

  test("TaskStop on a parked completed parent recursively stops its descendants", async () => {
    const parent = bgTasks.startTask({
      parentToolCallId: "parent-call",
      agentName: "parked-parent",
      lifecycleMode: "linked",
      isBackgrounded: true,
    });
    const child = bgTasks.startTask({
      parentToolCallId: "child-call",
      parentTaskId: parent.id,
      ownerId: "parent-fork",
      agentName: "running-child",
      lifecycleMode: "linked",
      isBackgrounded: true,
    });
    let childAborts = 0;
    bgControllers.register(child.parentToolCallId, {
      taskId: child.id,
      signal: () => {},
      isBackgrounded: () => false,
      abort: () => {
        childAborts += 1;
      },
    });
    bgTasks.completeTaskForRun(bgTasks.taskRunRef(parent), {
      content: "parent result",
      isError: false,
    });

    const result = await TaskStop.run(
      { id: "stop-parked", name: "TaskStop", input: { task_id: parent.id } },
      makeCtx(),
    );

    expect(result.is_error).not.toBe(true);
    expect(bgTasks.get(parent.id)?.status).toBe("killed");
    expect(bgTasks.get(child.id)?.status).toBe("killed");
    expect(bgTasks.get(child.id)?.terminalNotification).toBe("discarded");
    expect(childAborts).toBe(1);
    expect(emitQueue.peek().some((item) => item.replayKey?.startsWith(`bg:${child.id}:`))).toBe(
      false,
    );
  });

  test("TaskOutput rejects planning-task IDs as runtime tasks", async () => {
    const planningTask = create({ subject: "plan", description: "not runtime" });

    const result = await TaskOutput.run(
      { id: "output-call", name: "TaskOutput", input: { task_id: planningTask.id } },
      makeCtx(),
    );

    expect(result.is_error).toBe(true);
    expect(String(result.content)).toBe(`No task found with ID: ${planningTask.id}`);
  });

  test("TaskOutput polling aborts with the request signal", async () => {
    const task = bgTasks.startTask({
      parentToolCallId: "agent-call",
      agentName: "running-agent",
    });
    const controller = new AbortController();
    const pending = TaskOutput.run(
      {
        id: "output-call",
        name: "TaskOutput",
        input: { task_id: task.id, block: true, timeout: 600_000 },
      },
      makeCtx({ abortSignal: controller.signal }),
    );

    controller.abort();

    await expect(pending).rejects.toThrow();
  });
});
