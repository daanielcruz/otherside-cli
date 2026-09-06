import { writeTaskOutput } from "@/engine/background/tasks/output-files.ts";
import {
  createWorkflowBudget,
  createWorkflowTokenMeter,
  readWorkflowBudgetTotal,
  type WorkflowBudgetState,
} from "@/engine/background/workflows/runtime/budget/budget.ts";
import type {
  WorkflowDispatchRecord,
  WorkflowOutputRecord,
  WorkflowRunRecord,
} from "@/engine/background/workflows/runtime/history/run-ledger.ts";
import { persistWorkflowRun } from "@/engine/background/workflows/runtime/history/snapshot.ts";
import {
  createNestedWorkflowRejectHook,
  createWorkflowApi,
  type WorkflowApiHook,
  type WorkflowChildRun,
} from "@/engine/background/workflows/runtime/registry/api.ts";
import {
  getListedWorkflows,
  resolveWorkflow,
} from "@/engine/background/workflows/runtime/registry/registry.ts";
import type { WorkflowVmHooks } from "@/engine/background/workflows/runtime/runner/context.ts";
import { runWorkflowVm } from "@/engine/background/workflows/runtime/runner/vm-runner.ts";
import { formatWorkflowTaskOutput } from "@/engine/background/workflows/runtime/store/output.ts";
import {
  failWorkflowTask,
  finalizeWorkflowTask,
  getWorkflowTask,
  killWorkflowTask,
  updateWorkflowTask,
} from "@/engine/background/workflows/runtime/store/store.ts";
import { createWorkflowSubagentBridge } from "@/engine/background/workflows/runtime/subagent/bridge.ts";
import type { WorkflowTaskStatus } from "@/kernel/channels/workflow-tasks.ts";
import { errorMessage } from "@/kernel/std/errno.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  recordWorkflowAgentEvent,
  recordWorkflowFailure,
  recordWorkflowLog,
  recordWorkflowPhase,
} from "./progress.ts";

function isUserStoppedWorkflow(status: WorkflowTaskStatus): boolean {
  return status === "killed" || status === "paused";
}

// The only signal that ever aborts a workflow's local abortController without
// already having settled the task through killWorkflowTask/pauseWorkflowTask
// (both of which mark it terminal before this function's abort-settle branch
// runs) is the parent tool call's own abortSignal — i.e. the whole turn was
// cancelled out from under the running workflow. That cancellation always
// carries this reason; a bare, reasonless abort (or any other reason a future
// caller might attach) is treated as not stemming from that path, so this
// stays a derived check instead of an unconditional assumption.
const TURN_CANCELLED_ABORT_REASON = "user-cancel";

function isTurnCancelledAbort(reason: unknown): boolean {
  return reason === TURN_CANCELLED_ABORT_REASON;
}

export async function runLaunchedWorkflow(
  taskId: string,
  vmScript: import("node:vm").Script,
  args: unknown,
  ctx: RequestContext,
  runLog: {
    persistRecord: (record: WorkflowRunRecord) => Promise<void>;
    outputsByCacheKey: Map<string, WorkflowOutputRecord>;
    dispatchesByCacheKey: Map<string, WorkflowDispatchRecord[]>;
  },
): Promise<void> {
  const task = getWorkflowTask(taskId);
  if (!task) return;
  // Propagate the parent's abort reason onto the local controller so the
  // abort-settle branches below can tell this apart from any other future
  // source of an abort instead of assuming who caused it.
  const abortFromParent = (): void => task.abortController.abort(ctx.abortSignal?.reason);
  if (ctx.abortSignal?.aborted) abortFromParent();
  else ctx.abortSignal?.addEventListener("abort", abortFromParent, { once: true });
  const signal = task.abortController.signal;
  const meter = createWorkflowTokenMeter(task.totalTokens);
  const budget = createWorkflowBudget({ total: readWorkflowBudgetTotal(args), meter });
  let currentPhase: string | undefined;
  const setPhase = (title: string): void => {
    currentPhase = title;
    recordWorkflowPhase(taskId, title);
  };
  const bridge = await createWorkflowSubagentBridge({
    ctx,
    parentToolCallId: task.parentToolCallId,
    runId: task.workflowRunId,
    signal,
    onAgentEvent: (event) => recordWorkflowAgentEvent(taskId, event),
    onAgentController: (agentId, controller) => {
      const controllerTask = getWorkflowTask(taskId);
      if (!controllerTask?.agentControllers) return;
      if (controller === null) controllerTask.agentControllers.delete(agentId);
      else controllerTask.agentControllers.set(agentId, controller);
    },
    recordFailure: (message) => recordWorkflowFailure(taskId, message),
    log: (message) => recordWorkflowLog(taskId, message),
    getCurrentPhase: () => currentPhase,
    meter,
    budget,
    runLog,
  });
  const baseHooks: WorkflowVmHooks = {
    log: (message) => recordWorkflowLog(taskId, message),
    phase: setPhase,
    agent: bridge.agent,
    parallel: bridge.parallel,
    pipeline: bridge.pipeline,
  };
  const workflowHook = buildWorkflowApiHook({
    cwd: ctx.cwd,
    signal,
    baseHooks,
    budget,
    log: (message) => recordWorkflowLog(taskId, message),
    recordPhase: setPhase,
    getCurrentPhase: () => currentPhase,
    restoreCurrentPhase: (phase) => {
      currentPhase = phase;
    },
  });
  try {
    const result = await runWorkflowVm(vmScript, {
      args,
      signal,
      budget,
      hooks: { ...baseHooks, workflow: workflowHook },
    });
    const latest = getWorkflowTask(taskId);
    if (!latest || isUserStoppedWorkflow(latest.status)) return;
    const runId = latest.workflowRunId;
    if (result.error !== undefined) {
      if (signal.aborted) {
        const outputFile = await writeTaskOutput(
          taskId,
          formatWorkflowTaskOutput(latest, { status: "killed", error: "Workflow was stopped" }),
        );
        updateWorkflowTask(taskId, { outputFile });
        killWorkflowTask(taskId, isTurnCancelledAbort(signal.reason));
        const postTask = getWorkflowTask(taskId);
        if (postTask) {
          await persistWorkflowRun({
            cwd: ctx.cwd,
            sessionId: ctx.sessionId,
            runId,
            task: postTask,
          });
        }
        return;
      }
      const outputFile = await writeTaskOutput(
        taskId,
        formatWorkflowTaskOutput(latest, { status: "failed", error: result.error }),
      );
      failWorkflowTask(taskId, result.error, outputFile);
      const postTask = getWorkflowTask(taskId);
      if (postTask) {
        await persistWorkflowRun({ cwd: ctx.cwd, sessionId: ctx.sessionId, runId, task: postTask });
      }
      return;
    }
    const outputFile = await writeTaskOutput(
      taskId,
      formatWorkflowTaskOutput(latest, { status: "completed", result: result.result }),
    );
    finalizeWorkflowTask(taskId, result.result, outputFile);
    const postTask = getWorkflowTask(taskId);
    if (postTask) {
      await persistWorkflowRun({ cwd: ctx.cwd, sessionId: ctx.sessionId, runId, task: postTask });
    }
  } catch (error) {
    const latest = getWorkflowTask(taskId);
    if (!latest || isUserStoppedWorkflow(latest.status)) return;
    const runId = latest.workflowRunId;
    if (signal.aborted) {
      const outputFile = await writeTaskOutput(
        taskId,
        formatWorkflowTaskOutput(latest, { status: "killed", error: "Workflow was stopped" }),
      );
      updateWorkflowTask(taskId, { outputFile });
      killWorkflowTask(taskId, isTurnCancelledAbort(signal.reason));
      const postTask = getWorkflowTask(taskId);
      if (postTask) {
        await persistWorkflowRun({ cwd: ctx.cwd, sessionId: ctx.sessionId, runId, task: postTask });
      }
      return;
    }
    const message = errorMessage(error);
    const outputFile = await writeTaskOutput(
      taskId,
      formatWorkflowTaskOutput(latest, { status: "failed", error: message }),
    );
    failWorkflowTask(taskId, message, outputFile);
    const postTask = getWorkflowTask(taskId);
    if (postTask) {
      await persistWorkflowRun({ cwd: ctx.cwd, sessionId: ctx.sessionId, runId, task: postTask });
    }
  } finally {
    ctx.abortSignal?.removeEventListener("abort", abortFromParent);
  }
}

export function scopeChildWorkflowHooks(
  baseHooks: WorkflowVmHooks,
  childName: string,
): WorkflowVmHooks {
  return {
    ...baseHooks,
    log: (message) => baseHooks.log?.(`[${childName}] ${message}`),
    phase: (title) => baseHooks.phase?.(`▸ ${childName} / ${title}`),
    workflow: createNestedWorkflowRejectHook(),
  };
}

function buildWorkflowApiHook(input: {
  cwd: string;
  signal: AbortSignal;
  baseHooks: WorkflowVmHooks;
  budget: WorkflowBudgetState;
  log: (message: string) => void;
  recordPhase: (title: string) => void;
  getCurrentPhase: () => string | undefined;
  restoreCurrentPhase: (phase: string | undefined) => void;
}): WorkflowApiHook {
  const runChild = async (run: WorkflowChildRun): Promise<unknown> => {
    const childResult = await runWorkflowVm(run.vmScript, {
      args: run.args,
      signal: input.signal,
      budget: input.budget,
      hooks: scopeChildWorkflowHooks(input.baseHooks, run.name),
    });
    if (childResult.error !== undefined) {
      throw new Error(`workflow('${run.name}'): ${childResult.error}`);
    }
    return childResult.result;
  };
  return createWorkflowApi({
    cwd: input.cwd,
    signal: input.signal,
    resolveWorkflow,
    listWorkflows: getListedWorkflows,
    runChild,
    recordPhase: input.recordPhase,
    log: input.log,
    getCurrentPhase: input.getCurrentPhase,
    restoreCurrentPhase: input.restoreCurrentPhase,
  });
}
