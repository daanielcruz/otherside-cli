import { afterEach, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getWorkflowSnapshotsDir,
  readWorkflowSnapshot,
  type WorkflowSnapshot,
} from "@/engine/background/workflows/runtime/history/snapshot.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import { computeWorkflowProgress } from "../progress.ts";
import {
  buildWorkflowResumeCall,
  completeWorkflowTask,
  failWorkflowTask,
  getWorkflowTask,
  killWorkflowTask,
  listActiveWorkflowAgentProviders,
  pauseWorkflowTask,
  registerWorkflowTask,
  removeWorkflowTask,
  resetWorkflowTasksForTests,
  retryWorkflowAgent,
  setWorkflowEvictionDelayForTests,
  skipWorkflowAgent,
  truncateWorkflowResult,
  updateWorkflowTask,
} from "../store.ts";
import type { LocalWorkflowTaskState, WorkflowAgentProgress } from "../types.ts";

function makeRunningWorkflowTask(
  id: string,
  overrides: Partial<Omit<LocalWorkflowTaskState, "id">> = {},
): LocalWorkflowTaskState {
  return {
    id,
    type: "local_workflow",
    status: "running",
    parentToolCallId: `tool-${id}`,
    workflowRunId: `run-${id}`,
    cwd: "/tmp",
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
    ...overrides,
  };
}

function agentEntry(
  overrides: Partial<WorkflowAgentProgress> & Pick<WorkflowAgentProgress, "index" | "state">,
): WorkflowAgentProgress {
  return {
    type: "workflow_agent",
    label: `agent-${overrides.index}`,
    startedAt: Date.now(),
    lastProgressAt: Date.now(),
    ...overrides,
  };
}

function notificationTextFor(taskId: string): string | undefined {
  const item = emitQueue
    .peek({ class: "urgent_output" })
    .find((entry) => entry.replayKey === `wf:${taskId}`);
  return item?.payload.kind === "task_notification_xml" ? item.payload.text : undefined;
}

async function waitForSnapshotStatus(options: {
  cwd: string;
  sessionId: string;
  runId: string;
  status: WorkflowSnapshot["status"];
}): Promise<WorkflowSnapshot> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const snapshot = await readWorkflowSnapshot(options);
    if (snapshot?.status === options.status) return snapshot;
    await Bun.sleep(5);
  }
  throw new Error(`workflow snapshot never reached ${options.status}`);
}

describe("truncateWorkflowResult", () => {
  it("returns the result unchanged when within the upstream-sized cap", () => {
    const small = "x".repeat(8000);
    expect(truncateWorkflowResult(small, "/tmp/out.json")).toBe(small);
  });

  it("truncates oversized results and points to the output file", () => {
    const big = "y".repeat(8000 + 5000);
    const out = truncateWorkflowResult(big, "/tmp/out.json");

    expect(out.startsWith("y".repeat(8000))).toBe(true);
    expect(out).toContain("truncated 5000 chars");
    expect(out).toContain("full result in /tmp/out.json");
    expect(out.length).toBeLessThan(big.length);
  });

  it("omits the file pointer when no output file is known", () => {
    const big = "z".repeat(8000 + 10);
    const out = truncateWorkflowResult(big, undefined);

    expect(out).toContain("truncated 10 chars");
    expect(out).not.toContain("full result in");
  });
});

describe("workflow task store eviction and timers", () => {
  afterEach(() => {
    resetWorkflowTasksForTests();
    emitQueue._resetForTests();
  });

  it("cancels the pending eviction timer when a completed task is removed", async () => {
    setWorkflowEvictionDelayForTests(10);
    const task: LocalWorkflowTaskState = {
      id: "task-1",
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
      startedAt: Date.now(),
      abortController: new AbortController(),
    };

    registerWorkflowTask(task);
    completeWorkflowTask("task-1", "result", "/tmp/out");

    expect(getWorkflowTask("task-1")?.status).toBe("completed");

    removeWorkflowTask("task-1"); // must cancel the armed eviction timer

    // Re-register a fresh terminal task under the SAME id with no new timer. If the
    // remove had NOT cancelled the timer, it would fire at 10ms and evict this
    // terminal task; it surviving past 20ms proves the timer was cancelled.
    registerWorkflowTask({ ...task, status: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getWorkflowTask("task-1")?.status).toBe("completed");
  });
});

describe("workflow task snapshot persistence", () => {
  const cwd = join(tmpdir(), `otherside-finalize-workflow-store-${process.pid}`);
  const sessionId = "store-persistence";

  afterEach(async () => {
    resetWorkflowTasksForTests();
    emitQueue._resetForTests();
    await rm(getWorkflowSnapshotsDir(cwd, sessionId), { recursive: true, force: true });
  });

  it("replaces a paused snapshot with killed after the second stop action", async () => {
    const runId = "run-pause-then-kill";
    registerWorkflowTask(
      makeRunningWorkflowTask("wf-pause-then-kill", {
        cwd,
        sessionId,
        workflowRunId: runId,
      }),
    );

    expect(pauseWorkflowTask("wf-pause-then-kill")).toBe(true);
    expect(killWorkflowTask("wf-pause-then-kill", true)).toBe(true);

    const snapshot = await waitForSnapshotStatus({ cwd, sessionId, runId, status: "killed" });
    expect(snapshot.status).toBe("killed");
    expect(snapshot.error).toBe("Workflow was stopped");
  });
});

describe("killWorkflowTask autoTurn / stoppedByUser", () => {
  afterEach(() => {
    resetWorkflowTasksForTests();
    emitQueue._resetForTests();
  });

  function notificationFor(taskId: string) {
    return emitQueue
      .peek({ class: "urgent_output" })
      .find((item) => item.replayKey === `wf:${taskId}`);
  }

  function summaryOf(item: ReturnType<typeof notificationFor>): string | undefined {
    return item?.payload.kind === "task_notification_xml" ? item.payload.summary : undefined;
  }

  it("a model-initiated stop (no second argument) is not attributed to the user, and still wakes an idle turn", () => {
    registerWorkflowTask(makeRunningWorkflowTask("wf-model-stop"));

    killWorkflowTask("wf-model-stop");

    expect(getWorkflowTask("wf-model-stop")?.status).toBe("killed");
    expect(getWorkflowTask("wf-model-stop")?.stoppedByUser).toBeUndefined();
    const item = notificationFor("wf-model-stop");
    expect(item).toBeDefined();
    expect(item?.autoTurn).not.toBe(false);
    expect(summaryOf(item)).not.toContain("by the user");
    expect(emitQueue.hasPendingAutoTurn()).toBe(true);
  });

  it("a user-initiated stop is attributed to the user in the summary, but still wakes an idle turn", () => {
    registerWorkflowTask(makeRunningWorkflowTask("wf-user-stop"));

    killWorkflowTask("wf-user-stop", true);

    expect(getWorkflowTask("wf-user-stop")?.status).toBe("killed");
    expect(getWorkflowTask("wf-user-stop")?.stoppedByUser).toBe(true);
    const item = notificationFor("wf-user-stop");
    expect(item).toBeDefined();
    expect(item?.autoTurn).not.toBe(false);
    expect(summaryOf(item)).toContain("by the user");
    expect(emitQueue.hasPendingAutoTurn()).toBe(true);
  });
});

describe("workflow completion notification sections", () => {
  afterEach(() => {
    resetWorkflowTasksForTests();
    emitQueue._resetForTests();
  });

  it("failed run includes failure lines and resume guidance with runId + scriptPath", () => {
    registerWorkflowTask(
      makeRunningWorkflowTask("wf-fail", {
        scriptPath: "/tmp/workflows/demo.js",
        workflowRunId: "wf_abc123",
        args: { topic: "x" },
        failures: [
          "scout: timed out",
          "parallel[1]: schema agent did not return structured output",
        ],
        agentCount: 2,
        totalTokens: 1200,
        totalToolCalls: 4,
      }),
    );

    failWorkflowTask("wf-fail", "agent abandoned after 3 attempts", "/tmp/out-fail");

    const text = notificationTextFor("wf-fail");
    expect(text).toBeDefined();
    expect(text).toContain("<status>failed</status>");
    expect(text).toContain("<failures>");
    expect(text).toContain("scout: timed out");
    expect(text).toContain("parallel[1]: schema agent did not return structured output");
    expect(text).toContain("<recovery>");
    expect(text).toContain('resumeFromRunId: "wf_abc123"');
    expect(text).toContain('scriptPath: "/tmp/workflows/demo.js"');
    expect(text).toContain('args: {"topic":"x"}');
    expect(text).toContain("Agent transcripts:");
    expect(text).toContain("<agent_count>2</agent_count>");
    expect(text).toContain("<subagent_tokens>1200</subagent_tokens>");
    expect(text).not.toContain("<diagnostics>");
  });

  it("successful run includes result location, diagnostics, and agent counts", () => {
    registerWorkflowTask(
      makeRunningWorkflowTask("wf-ok", {
        scriptPath: "/tmp/workflows/ok.js",
        workflowRunId: "wf_ok99",
        agentCount: 3,
        totalTokens: 500,
        totalToolCalls: 7,
        workflowProgress: [
          {
            type: "workflow_agent",
            index: 0,
            label: "a",
            state: "done",
            startedAt: 1,
            lastProgressAt: 2,
            resultPreview: '{"ok":true}',
          },
          {
            type: "workflow_agent",
            index: 1,
            label: "b",
            state: "done",
            startedAt: 1,
            lastProgressAt: 2,
            resultPreview: "[]",
          },
          {
            type: "workflow_agent",
            index: 2,
            label: "c",
            state: "error",
            skipped: true,
            startedAt: 1,
            lastProgressAt: 2,
          },
        ],
      }),
    );

    completeWorkflowTask("wf-ok", { answer: 42 }, "/tmp/out-ok");

    const text = notificationTextFor("wf-ok");
    expect(text).toBeDefined();
    expect(text).toContain("<status>completed</status>");
    expect(text).toContain("<result>");
    expect(text).toContain('"answer":42');
    expect(text).toContain("<output-file>/tmp/out-ok</output-file>");
    expect(text).toContain("<diagnostics>");
    expect(text).toContain("journal.jsonl");
    expect(text).toContain('resumeFromRunId: "wf_ok99"');
    expect(text).toContain("To re-run with edited post-processing");
    expect(text).toContain("<agent_count>3</agent_count>");
    expect(text).toContain("<agents_done>2</agents_done>");
    expect(text).toContain("<agents_error>0</agents_error>");
    expect(text).toContain("<agents_skipped>1</agents_skipped>");
    expect(text).toContain("<agents_empty_result>1</agents_empty_result>");
    expect(text).toContain("<tool_uses>7</tool_uses>");
    expect(text).not.toContain("<recovery>");
  });

  it("killed run surfaces recovery guidance without a result section", () => {
    registerWorkflowTask(
      makeRunningWorkflowTask("wf-kill", {
        scriptPath: "/tmp/workflows/stop.js",
        workflowRunId: "wf_stop1",
      }),
    );
    updateWorkflowTask("wf-kill", { outputFile: "/tmp/out-kill" });

    killWorkflowTask("wf-kill", true);

    const text = notificationTextFor("wf-kill");
    expect(text).toBeDefined();
    expect(text).toContain("<status>killed</status>");
    expect(text).toContain("<recovery>");
    expect(text).toContain('resumeFromRunId: "wf_stop1"');
    expect(text).not.toContain("<result>");
    expect(text).not.toContain("<diagnostics>");
  });
});

describe("buildWorkflowResumeCall", () => {
  it("rebuilds a Workflow(...) call from scriptPath + runId, without args", () => {
    const call = buildWorkflowResumeCall({
      scriptPath: "/tmp/workflows/demo.js",
      runId: "wf_abc123",
    });
    expect(call).toBe(
      'Workflow({scriptPath: "/tmp/workflows/demo.js", resumeFromRunId: "wf_abc123"})',
    );
  });

  it("includes args verbatim (JSON-encoded) when the run carried them", () => {
    const call = buildWorkflowResumeCall({
      scriptPath: "/tmp/workflows/demo.js",
      runId: "wf_abc123",
      args: { topic: "x" },
    });
    expect(call).toContain('args: {"topic":"x"}');
  });

  it("escapes quotes in script paths and run ids", () => {
    const call = buildWorkflowResumeCall({
      scriptPath: "/tmp/o'clock/demo.js",
      runId: 'wf_"quoted"',
    });
    expect(call).toBe(
      'Workflow({scriptPath: "/tmp/o\'clock/demo.js", resumeFromRunId: "wf_\\"quoted\\""})',
    );
  });
});

describe("skipWorkflowAgent / retryWorkflowAgent", () => {
  afterEach(() => {
    resetWorkflowTasksForTests();
    emitQueue._resetForTests();
  });

  it("aborts the targeted agent's controller with the skip reason and reports success", () => {
    const task = makeRunningWorkflowTask("wf-skip", { agentControllers: new Map() });
    registerWorkflowTask(task);
    const controller = new AbortController();
    task.agentControllers?.set("workflow-run-1-0", controller);

    const ok = skipWorkflowAgent("workflow-run-1-0");

    expect(ok).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe("user-skip");
  });

  it("aborts the targeted agent's controller with the retry reason and reports success", () => {
    const task = makeRunningWorkflowTask("wf-retry", { agentControllers: new Map() });
    registerWorkflowTask(task);
    const controller = new AbortController();
    task.agentControllers?.set("workflow-run-1-1", controller);

    const ok = retryWorkflowAgent("workflow-run-1-1");

    expect(ok).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe("user-retry");
  });

  it("returns false for an unknown agent id, and false once the workflow is no longer running", () => {
    const task = makeRunningWorkflowTask("wf-done", { agentControllers: new Map() });
    registerWorkflowTask(task);

    expect(skipWorkflowAgent("no-such-agent")).toBe(false);

    const controller = new AbortController();
    task.agentControllers?.set("workflow-run-2-0", controller);
    completeWorkflowTask("wf-done", "result", "/tmp/out");

    expect(retryWorkflowAgent("workflow-run-2-0")).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });
});

describe("computeWorkflowProgress", () => {
  it("a stop-aborted agent yields failedCount 0, stoppedCount 1, complete true; a genuine error still counts failed", () => {
    const progressStopped = computeWorkflowProgress(
      [
        {
          type: "workflow_agent",
          index: 0,
          label: "agent-1",
          state: "error",
          stopped: true,
          startedAt: Date.now(),
          lastProgressAt: Date.now(),
        },
      ],
      1,
    );
    expect(progressStopped.failedCount).toBe(0);
    expect(progressStopped.stoppedCount).toBe(1);
    expect(progressStopped.complete).toBe(true);

    const progressError = computeWorkflowProgress(
      [
        {
          type: "workflow_agent",
          index: 0,
          label: "agent-2",
          state: "error",
          startedAt: Date.now(),
          lastProgressAt: Date.now(),
        },
      ],
      1,
    );
    expect(progressError.failedCount).toBe(1);
    expect(progressError.stoppedCount).toBe(0);
    expect(progressError.complete).toBe(true);
  });
});

describe("listActiveWorkflowAgentProviders", () => {
  afterEach(() => {
    resetWorkflowTasksForTests();
  });

  it("collects distinct providers of in-flight stage agents in running workflows", () => {
    registerWorkflowTask(
      makeRunningWorkflowTask("wf-a", {
        workflowProgress: [
          agentEntry({ index: 0, provider: "codex", state: "start" }),
          agentEntry({ index: 1, provider: "codex", state: "start" }),
          agentEntry({ index: 2, provider: "glm", state: "done" }),
          { type: "workflow_log", message: "noise" },
        ],
      }),
    );
    expect(listActiveWorkflowAgentProviders()).toEqual(["codex"]);
  });

  it("ignores non-running workflows and entries without a provider", () => {
    registerWorkflowTask(
      makeRunningWorkflowTask("wf-b", {
        status: "completed",
        workflowProgress: [agentEntry({ index: 0, provider: "codex", state: "start" })],
      }),
    );
    registerWorkflowTask(
      makeRunningWorkflowTask("wf-c", {
        workflowProgress: [agentEntry({ index: 0, state: "start" })],
      }),
    );
    expect(listActiveWorkflowAgentProviders()).toEqual([]);
  });
});
