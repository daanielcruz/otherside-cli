import { describe, expect, test } from "bun:test";
import type { BackgroundTask } from "@/engine/background/tasks/background.ts";
import type {
  WorkflowTaskLifecycle,
  WorkflowTaskStatus,
} from "@/engine/background/workflows/runtime/store/types.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import {
  activateStringViewBackgroundCompletions,
  backgroundTaskNoticeData,
  workflowTaskNoticeData,
} from "@/ui/app/dispatch/string-view-background-completions.ts";

type BackgroundStatus = BackgroundTask["status"];
type TaskCompletionListener = (task: BackgroundTask) => void;
type WorkflowCompletionListener = (task: WorkflowTaskLifecycle) => void;

function backgroundTask(
  kind: BackgroundTask["kind"],
  status: BackgroundStatus,
  id = `${kind}-${status}`,
): BackgroundTask {
  return {
    id,
    kind,
    parentToolCallId: `call-${id}`,
    agentName: kind === "agent" ? "reviewer" : "Bash",
    description: `${kind} ${status}`,
    runGeneration: 0,
    runToken: `${id}:0:token`,
    lifecycleMode: "detached",
    terminalNotification: "main",
    status,
    startedAt: 100,
    endedAt: 140,
    isBackgrounded: true,
    actions: [],
    assistantText: "",
    shellOutput: "",
    inputTokens: 0,
    outputTokens: 0,
    notified: true,
    ...(status === "error" ? { error: "failed task" } : {}),
    ...(kind === "shell" ? { exitCode: status === "completed" ? 0 : 1 } : {}),
  };
}

function workflowTask(
  status: WorkflowTaskStatus,
  id = `workflow-${status}`,
): WorkflowTaskLifecycle {
  return {
    id,
    type: "local_workflow",
    status,
    parentToolCallId: `call-${id}`,
    workflowRunId: `run-${id}`,
    cwd: "/repo",
    sessionId: "session",
    workflowName: "verify",
    description: `workflow ${status}`,
    workflowProgress: [],
    progressVersion: 0,
    agentCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    logs: [],
    startedAt: 200,
    endedAt: 260,
    abortController: new AbortController(),
    ...(status === "failed" ? { error: "workflow failed" } : {}),
  };
}

function completionHarness(initialEntries: readonly TranscriptEntry[] = []) {
  let entries = initialEntries;
  let repaints = 0;
  let taskStoreListener: (() => void) | undefined;
  let taskCompletionListener: TaskCompletionListener | undefined;
  let workflowCompletionListener: WorkflowCompletionListener | undefined;
  let queueListener: (() => void) | undefined;
  let drainListener: (() => void) | undefined;
  let listedTasks: BackgroundTask[] = [];
  const consumed = new Set<string>();
  let pendingAutoTurn = true;
  let turnBusy = false;
  let resumes = 0;

  const deactivate = activateStringViewBackgroundCompletions({
    requestRepaint: () => {
      repaints += 1;
    },
    requestBackgroundResume: () => {
      resumes += 1;
    },
    isTurnBusy: () => turnBusy,
    queue: {
      hasPendingAutoTurn: () => pendingAutoTurn,
      wasReplayKeyConsumed: (key) => consumed.has(key),
      subscribe: (listener) => {
        queueListener = listener;
        return () => {
          queueListener = undefined;
        };
      },
      onDrain: (listener) => {
        drainListener = listener;
        return () => {
          drainListener = undefined;
        };
      },
    },
    listBackgroundTasks: () => listedTasks,
    subscribeBackgroundTasks: (listener) => {
      taskStoreListener = listener;
      return () => {
        taskStoreListener = undefined;
      };
    },
    subscribeBackgroundCompletion: (listener) => {
      taskCompletionListener = listener;
      return () => {
        taskCompletionListener = undefined;
      };
    },
    subscribeWorkflowCompletion: (listener) => {
      workflowCompletionListener = listener;
      return () => {
        workflowCompletionListener = undefined;
      };
    },
    getTranscriptEntries: () => entries,
    updateTranscript: (updater) => {
      entries = updater(entries);
    },
  });

  return {
    deactivate,
    entries: () => entries,
    repaints: () => repaints,
    resumes: () => resumes,
    setListedTasks: (tasks: BackgroundTask[]) => {
      listedTasks = tasks;
      taskStoreListener?.();
    },
    completeTask: (task: BackgroundTask) => taskCompletionListener?.(task),
    completeWorkflow: (task: WorkflowTaskLifecycle) => workflowCompletionListener?.(task),
    hasTaskCompletionListener: () => taskCompletionListener !== undefined,
    hasWorkflowCompletionListener: () => workflowCompletionListener !== undefined,
    setTurnBusy: (busy: boolean) => {
      turnBusy = busy;
    },
    setPendingAutoTurn: (pending: boolean) => {
      pendingAutoTurn = pending;
    },
    /** Model consumption of a queued notification, followed by its drain callback. */
    consume: (...replayKeys: string[]) => {
      for (const key of replayKeys) consumed.add(key);
      drainListener?.();
    },
    emitQueueChanged: () => queueListener?.(),
  };
}

describe("string-view background completion notices", () => {
  test("projects completed, failed, and killed Agent, Bash, and Workflow completions once", () => {
    const harness = completionHarness();
    const statuses: BackgroundStatus[] = ["completed", "error", "killed"];
    const replayKeys: string[] = [];
    for (const status of statuses) {
      const agent = backgroundTask("agent", status);
      harness.completeTask(agent);
      harness.completeTask(agent);
      replayKeys.push(`bg:${agent.id}:0`);

      const shell = backgroundTask("shell", status);
      harness.completeTask(shell);
      harness.completeTask(shell);
      replayKeys.push(`bg:${shell.id}:0`);
    }
    for (const status of ["completed", "failed", "killed"] as const) {
      const workflow = workflowTask(status);
      harness.completeWorkflow(workflow);
      harness.completeWorkflow(workflow);
      replayKeys.push(`wf:${workflow.id}`);
    }
    harness.consume(...replayKeys);

    const notices = harness.entries().filter((entry) => entry.kind === "task_notice");
    expect(notices).toHaveLength(9);
    expect(notices.map((entry) => JSON.parse(entry.text).status)).toEqual([
      "completed",
      "completed",
      "failed",
      "failed",
      "killed",
      "killed",
      "completed",
      "failed",
      "killed",
    ]);
    expect(harness.repaints()).toBe(9);
  });

  test("parks a completion until the model consumes it", () => {
    const harness = completionHarness();
    const task = backgroundTask("agent", "completed", "parked");

    harness.completeTask(task);
    expect(harness.entries()).toHaveLength(0);

    harness.consume("bg:parked:0");
    expect(harness.entries()).toHaveLength(1);
    expect(JSON.parse(harness.entries()[0]?.text ?? "{}").taskId).toBe("parked");
  });

  test("wakes an idle turn once and stays silent while one is running", () => {
    const harness = completionHarness();

    harness.setTurnBusy(true);
    harness.completeTask(backgroundTask("agent", "completed", "busy"));
    expect(harness.resumes()).toBe(0);

    harness.setTurnBusy(false);
    harness.completeTask(backgroundTask("agent", "completed", "idle"));
    expect(harness.resumes()).toBe(1);
  });

  test("never resumes without a pending auto-turn", () => {
    const harness = completionHarness();
    harness.setPendingAutoTurn(false);

    harness.completeTask(backgroundTask("shell", "completed", "no-auto-turn"));
    harness.emitQueueChanged();

    expect(harness.resumes()).toBe(0);
  });

  test("does not replay completed tasks on activation or resume", () => {
    const existingNotice: TranscriptEntry = {
      id: "n_bg:already-visible:0",
      kind: "task_notice",
      text: "{}",
      isError: false,
    };
    const harness = completionHarness([existingNotice]);
    harness.setListedTasks([backgroundTask("agent", "completed", "completed-before-boot")]);

    expect(harness.entries()).toEqual([existingNotice]);
    expect(harness.repaints()).toBe(0);
  });

  test("stamps background Agent identity and model without projecting a completion", () => {
    const harness = completionHarness([
      {
        id: "b_call-agent",
        kind: "tool",
        text: JSON.stringify({ subagent_type: "general-purpose" }),
      },
    ]);
    const task = {
      ...backgroundTask("agent", "completed", "identity"),
      parentToolCallId: "call-agent",
      model: "claude-sonnet-4-6",
      provider: "anthropic" as const,
      agentName: "reviewer",
    };
    harness.setListedTasks([task]);

    expect(harness.entries()).toHaveLength(1);
    expect(harness.entries()[0]).toMatchObject({
      agentModel: "claude-sonnet-4-6",
      agentProvider: "anthropic",
    });
    expect(JSON.parse(harness.entries()[0]?.text ?? "{}").subagent_type).toBe("reviewer");
    expect(harness.repaints()).toBe(1);
  });

  test("teardown removes all completion subscriptions", () => {
    const harness = completionHarness();
    harness.deactivate();

    expect(harness.hasTaskCompletionListener()).toBe(false);
    expect(harness.hasWorkflowCompletionListener()).toBe(false);
    harness.completeTask(backgroundTask("agent", "completed"));
    harness.completeWorkflow(workflowTask("completed"));
    expect(harness.entries()).toHaveLength(0);
  });

  test("notice payloads retain failure details, exit code, and duration", () => {
    expect(backgroundTaskNoticeData(backgroundTask("agent", "error"))).toMatchObject({
      taskKind: "agent",
      status: "failed",
      error: "failed task",
      durationMs: 40,
    });
    expect(backgroundTaskNoticeData(backgroundTask("shell", "error"))).toMatchObject({
      taskKind: "shell",
      status: "failed",
      exitCode: 1,
      durationMs: 40,
    });
    expect(workflowTaskNoticeData(workflowTask("failed"))).toMatchObject({
      taskKind: "workflow",
      status: "failed",
      error: "workflow failed",
      durationMs: 60,
    });
  });
});
