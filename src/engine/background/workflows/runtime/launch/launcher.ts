import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { writeTaskOutput } from "@/engine/background/tasks/output-files.ts";
import {
  createWorkflowBudget,
  createWorkflowTokenMeter,
  readWorkflowBudgetTotal,
  type WorkflowBudgetState,
} from "@/engine/background/workflows/runtime/budget/budget.ts";
import { compileWorkflowScript } from "@/engine/background/workflows/runtime/compiler/compile.ts";
import { usesNonDeterministicApi } from "@/engine/background/workflows/runtime/compiler/determinism.ts";
import type {
  WorkflowJournalEntry,
  WorkflowJournalResultEntry,
  WorkflowJournalStartedEntry,
} from "@/engine/background/workflows/runtime/history/journal.ts";
import { WorkflowJournal } from "@/engine/background/workflows/runtime/history/journal.ts";
import {
  getWorkflowTranscriptDir,
  persistWorkflowScript,
  readWorkflowFromPath,
} from "@/engine/background/workflows/runtime/history/paths.ts";
import {
  persistWorkflowRun,
  readWorkflowSnapshot,
} from "@/engine/background/workflows/runtime/history/snapshot.ts";
import type {
  WorkflowInput,
  WorkflowLaunchOutcome,
  WorkflowLaunchResult,
} from "@/engine/background/workflows/runtime/launch/types.ts";
import { parseWorkflowScript } from "@/engine/background/workflows/runtime/parser/meta.ts";
import {
  createNestedWorkflowRejectHook,
  createWorkflowApi,
  type WorkflowApiHook,
  type WorkflowChildRun,
} from "@/engine/background/workflows/runtime/registry/api.ts";
import {
  getAllWorkflows,
  resolveWorkflow,
} from "@/engine/background/workflows/runtime/registry/registry.ts";
import type { WorkflowVmHooks } from "@/engine/background/workflows/runtime/runner/context.ts";
import { runWorkflowVm } from "@/engine/background/workflows/runtime/runner/vm-runner.ts";
import { cloneWorkflowBoundaryValue } from "@/engine/background/workflows/runtime/sandbox/clone.ts";
import { formatWorkflowTaskOutput } from "@/engine/background/workflows/runtime/store/output.ts";
import {
  completeWorkflowTask,
  failWorkflowTask,
  getRunningWorkflowByRunId,
  getWorkflowTask,
  killWorkflowTask,
  listWorkflowTasks,
  registerWorkflowTask,
  removeWorkflowTask,
  updateWorkflowTask,
} from "@/engine/background/workflows/runtime/store/store.ts";
import type {
  LocalWorkflowTaskState,
  WorkflowProgressEntry,
} from "@/engine/background/workflows/runtime/store/types.ts";
import {
  createWorkflowSubagentBridge,
  type WorkflowAgentEvent,
} from "@/engine/background/workflows/runtime/subagent/bridge.ts";
import type { WorkflowTaskStatus } from "@/kernel/channels/workflow-tasks.ts";
import { errorMessage } from "@/kernel/std/errno.ts";
import { generateTaskId } from "@/kernel/std/id.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export const WORKFLOW_RUN_ID_PATTERN = /^wf_[a-z0-9-]{6,}$/;

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

export async function launchWorkflow(
  input: unknown,
  ctx: RequestContext,
  parentToolCallId: string,
): Promise<WorkflowLaunchOutcome> {
  const args = readWorkflowInput(input);
  if (args === null) return { ok: false, error: "Workflow input must be an object." };

  const resumeFromRunId =
    typeof args.resumeFromRunId === "string" && args.resumeFromRunId.length > 0
      ? args.resumeFromRunId
      : undefined;

  if (resumeFromRunId !== undefined && !WORKFLOW_RUN_ID_PATTERN.test(resumeFromRunId)) {
    return { ok: false, error: `resumeFromRunId must match ${String(WORKFLOW_RUN_ID_PATTERN)}.` };
  }

  if (resumeFromRunId !== undefined) {
    const running = getRunningWorkflowByRunId(resumeFromRunId);
    if (running) {
      return {
        ok: false,
        error: `Workflow ${resumeFromRunId} is still running (task ${running.id}). Stop it first with TaskStop({taskId: "${running.id}"}) before resuming.`,
      };
    }
  }

  const resumeState =
    resumeFromRunId !== undefined
      ? await loadResumeState({ cwd: ctx.cwd, sessionId: ctx.sessionId, runId: resumeFromRunId })
      : null;

  const resolution = await resolveWorkflowScriptSource({ args, cwd: ctx.cwd, resume: resumeState });
  if (!resolution.ok) return { ok: false, error: resolution.error };
  const script = resolution.source.script;
  const resolvedScriptPath = resolution.source.resolvedScriptPath;

  const parsed = parseWorkflowScript(script);
  const isInlineScript = resolvedScriptPath === undefined;
  if (isInlineScript && usesNonDeterministicApi(parsed.body)) {
    return {
      ok: false,
      error:
        "Workflow script uses Date.now(), Math.random(), Date(), or argless new Date(), which are unavailable because they break resume.",
    };
  }
  const compiled = compileWorkflowScript(parsed.body);
  if (!compiled.ok) return { ok: false, error: compiled.error };

  const runId = resumeFromRunId ?? `wf_${randomUUID().slice(0, 12)}`;

  if (resumeFromRunId !== undefined) {
    for (const task of listWorkflowTasks()) {
      if (
        task.type === "local_workflow" &&
        task.workflowRunId === resumeFromRunId &&
        task.status !== "running"
      ) {
        removeWorkflowTask(task.id);
      }
    }
  }

  const taskId = generateTaskId("w");
  const transcriptDir = getWorkflowTranscriptDir(ctx.cwd, ctx.sessionId, runId);
  await mkdir(transcriptDir, { recursive: true });
  const scriptPath =
    resolvedScriptPath ??
    (await persistWorkflowScript({
      cwd: ctx.cwd,
      sessionId: ctx.sessionId,
      runId,
      workflowName: parsed.meta.name,
      script,
    }));
  const abortController = new AbortController();
  const summary = `Workflow "${parsed.meta.title ?? parsed.meta.name}" launched.`;
  const effectiveArgs = resolveEffectiveWorkflowArgs({ args, resume: resumeState });
  const task: LocalWorkflowTaskState = {
    id: taskId,
    type: "local_workflow",
    status: "running",
    parentToolCallId,
    workflowRunId: runId,
    cwd: ctx.cwd,
    sessionId: ctx.sessionId,
    provider: ctx.provider,
    model: ctx.model,
    workflowName: parsed.meta.name,
    ...(parsed.meta.title !== undefined ? { title: parsed.meta.title } : {}),
    description: parsed.meta.description,
    script,
    scriptPath,
    ...(effectiveArgs.present
      ? { args: cloneWorkflowBoundaryValue(effectiveArgs.value) ?? null }
      : {}),
    summary,
    ...(parsed.meta.phases !== undefined ? { phases: parsed.meta.phases } : {}),
    workflowProgress: [],
    progressVersion: 0,
    agentCount: 0,
    totalTokens: resumeState?.totalTokens ?? 0,
    totalToolCalls: 0,
    logs: [],
    startedAt: Date.now(),
    abortController,
    agentControllers: new Map(),
    ...(ctx.agentOwnerId !== undefined ? { ownerId: ctx.agentOwnerId } : {}),
  };
  registerWorkflowTask(task);
  const vmArgs = task.args ?? null;
  const journal = new WorkflowJournal(transcriptDir);
  await journal.append({ type: "meta", args: vmArgs, scriptPath });
  await persistWorkflowRun({ cwd: ctx.cwd, sessionId: ctx.sessionId, runId, task });
  const journalSnapshot = await journal.load();
  void runLaunchedWorkflow(taskId, compiled.vmScript, vmArgs, ctx, {
    append: (entry) => journal.append(entry),
    results: journalSnapshot.results,
    started: journalSnapshot.started,
  });

  const result: WorkflowLaunchResult = {
    status: "async_launched",
    taskId,
    taskType: "local_workflow",
    workflowName: parsed.meta.name,
    runId,
    summary,
    transcriptDir,
    scriptPath,
  };
  return {
    ok: true,
    result,
    message: buildLaunchMessage({
      taskId,
      runId,
      scriptPath,
      transcriptDir,
      description: parsed.meta.description,
    }),
  };
}

function buildLaunchMessage(parts: {
  taskId: string;
  runId: string;
  scriptPath: string;
  transcriptDir: string;
  description: string;
}): string {
  return [
    `Workflow launched in background. Task ID: ${parts.taskId}`,
    `Summary: ${parts.description}`,
    "",
    "The result is delivered to you inline when it completes — you will be notified automatically. Do NOT read the transcript or journal files to obtain the result; wait for the notification. Use /workflows to watch live progress.",
    "",
    "For resume/iteration only (not needed to receive the result):",
    `Run ID: ${parts.runId}`,
    `Script file: ${parts.scriptPath}`,
    `Transcript dir: ${parts.transcriptDir}`,
    `To iterate: edit the script file with Write/Edit, then re-invoke Workflow({scriptPath: "${parts.scriptPath}", resumeFromRunId: "${parts.runId}"}) — completed agents return cached results.`,
  ].join("\n");
}

function readWorkflowInput(input: unknown): WorkflowInput | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  return input as WorkflowInput;
}

interface ResumeState {
  argsPresent: boolean;
  args: unknown;
  script?: string;
  scriptPath?: string;
  totalTokens: number;
}

interface WorkflowScriptSource {
  script: string;
  resolvedScriptPath?: string;
}

type WorkflowScriptResolution =
  | { ok: true; source: WorkflowScriptSource }
  | { ok: false; error: string };

const WORKFLOW_SCRIPT_REQUIRED_ERROR =
  "`script` is required and must be a non-empty workflow JavaScript string.";

async function loadResumeState(options: {
  cwd: string;
  sessionId: string;
  runId: string;
}): Promise<ResumeState | null> {
  const transcriptDir = getWorkflowTranscriptDir(options.cwd, options.sessionId, options.runId);
  const journalSnapshot = await new WorkflowJournal(transcriptDir).load();
  const snapshot = await readWorkflowSnapshot(options);
  const meta = journalSnapshot.meta;
  if (meta !== undefined) {
    const resumeScriptPath = meta.scriptPath ?? snapshot?.scriptPath;
    return {
      argsPresent: true,
      args: meta.args,
      ...(snapshot?.script !== undefined ? { script: snapshot.script } : {}),
      ...(resumeScriptPath !== undefined ? { scriptPath: resumeScriptPath } : {}),
      totalTokens: snapshot?.totalTokens ?? 0,
    };
  }
  if (snapshot !== null) {
    return {
      argsPresent: true,
      args: snapshot.args ?? null,
      ...(snapshot.script !== undefined ? { script: snapshot.script } : {}),
      ...(snapshot.scriptPath !== undefined ? { scriptPath: snapshot.scriptPath } : {}),
      totalTokens: snapshot.totalTokens ?? 0,
    };
  }
  return null;
}

async function resolveResumeScriptSource(options: {
  cwd: string;
  resume: ResumeState;
}): Promise<WorkflowScriptResolution> {
  const { cwd, resume } = options;
  if (resume.scriptPath !== undefined) {
    const loaded = await readWorkflowFromPath(cwd, resume.scriptPath);
    if (loaded.ok) {
      return {
        ok: true,
        source: { script: loaded.script, resolvedScriptPath: loaded.resolvedPath },
      };
    }
    if (resume.script !== undefined) {
      return { ok: true, source: { script: resume.script, resolvedScriptPath: resume.scriptPath } };
    }
    return { ok: false, error: loaded.error };
  }
  if (resume.script !== undefined) {
    return { ok: true, source: { script: resume.script } };
  }
  return { ok: false, error: WORKFLOW_SCRIPT_REQUIRED_ERROR };
}

async function resolveWorkflowScriptSource(options: {
  args: WorkflowInput;
  cwd: string;
  resume: ResumeState | null;
}): Promise<WorkflowScriptResolution> {
  const { args, cwd, resume } = options;
  if (typeof args.scriptPath === "string" && args.scriptPath.length > 0) {
    const loaded = await readWorkflowFromPath(cwd, args.scriptPath);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    return { ok: true, source: { script: loaded.script, resolvedScriptPath: loaded.resolvedPath } };
  }
  if (typeof args.script === "string" && args.script.length > 0) {
    return { ok: true, source: { script: args.script } };
  }
  if (typeof args.name === "string" && args.name.length > 0) {
    const resolved = await resolveWorkflow(args.name, cwd);
    if (resolved) return { ok: true, source: { script: resolved.script } };
    const available = (await getAllWorkflows(cwd)).map((workflow) => workflow.name).join(", ");
    return {
      ok: false,
      error: `No workflow named "${args.name}". Available: ${available || "(none)"}.`,
    };
  }
  if (resume !== null) return resolveResumeScriptSource({ cwd, resume });
  return { ok: false, error: WORKFLOW_SCRIPT_REQUIRED_ERROR };
}

function resolveEffectiveWorkflowArgs(options: {
  args: WorkflowInput;
  resume: ResumeState | null;
}): { present: boolean; value: unknown } {
  if (options.args.args !== undefined) return { present: true, value: options.args.args };
  if (options.resume?.argsPresent) {
    return { present: true, value: options.resume.args };
  }
  return { present: false, value: undefined };
}

async function runLaunchedWorkflow(
  taskId: string,
  vmScript: import("node:vm").Script,
  args: unknown,
  ctx: RequestContext,
  journalOption: {
    append: (entry: WorkflowJournalEntry) => Promise<void>;
    results: Map<string, WorkflowJournalResultEntry>;
    started: Map<string, WorkflowJournalStartedEntry[]>;
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
    journal: journalOption,
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
    completeWorkflowTask(taskId, result.result, outputFile);
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
    getAllWorkflows,
    runChild,
    recordPhase: input.recordPhase,
    log: input.log,
    getCurrentPhase: input.getCurrentPhase,
    restoreCurrentPhase: input.restoreCurrentPhase,
  });
}

function recordWorkflowLog(taskId: string, message: string): void {
  const task = getWorkflowTask(taskId);
  if (!task) return;
  updateWorkflowTask(taskId, {
    logs: [...task.logs, message],
    progressVersion: task.progressVersion + 1,
  });
}

function recordWorkflowFailure(taskId: string, message: string): void {
  const task = getWorkflowTask(taskId);
  if (!task) return;
  updateWorkflowTask(taskId, {
    failures: [...(task.failures ?? []), message],
    logs: [...task.logs, `failure: ${message}`],
    progressVersion: task.progressVersion + 1,
  });
}

function recordWorkflowAgentEvent(taskId: string, event: WorkflowAgentEvent): void {
  const task = getWorkflowTask(taskId);
  if (!task) return;
  const now = Date.now();
  const existingIndex = task.workflowProgress.findIndex(
    (entry) => entry.type === "workflow_agent" && entry.index === event.index,
  );
  const existing = existingIndex >= 0 ? task.workflowProgress[existingIndex] : undefined;
  const startedAt =
    existing !== undefined && existing.type === "workflow_agent" ? existing.startedAt : now;
  const existingTokens =
    existing !== undefined && existing.type === "workflow_agent" ? existing.tokens : undefined;
  const nextTokens = event.tokens ?? existingTokens;
  const toolCallCount = event.transcript?.toolCalls.length;
  const entry: WorkflowProgressEntry = {
    type: "workflow_agent",
    index: event.index,
    label: event.label,
    ...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
    ...(event.phaseTitle !== undefined ? { phaseTitle: event.phaseTitle } : {}),
    ...(event.provider !== undefined ? { provider: event.provider } : {}),
    ...(event.model !== undefined ? { model: event.model } : {}),
    state: event.state,
    startedAt,
    lastProgressAt: now,
    ...(event.transcript !== undefined ? { transcript: event.transcript } : {}),
    ...(toolCallCount !== undefined ? { toolCalls: toolCallCount } : {}),
    ...(nextTokens !== undefined ? { tokens: nextTokens } : {}),
    ...(event.prompt !== undefined ? { promptPreview: event.prompt } : {}),
    ...(event.resultPreview !== undefined ? { resultPreview: event.resultPreview } : {}),
    ...(event.lastToolName !== undefined ? { lastToolName: event.lastToolName } : {}),
    ...(event.lastToolSummary !== undefined ? { lastToolSummary: event.lastToolSummary } : {}),
    ...(event.agentType !== undefined ? { agentType: event.agentType } : {}),
    ...(event.cached === true ? { cached: true } : {}),
    ...(event.skipped === true ? { skipped: true } : {}),
    ...(event.stopped === true ? { stopped: true } : {}),
    ...(event.isolation !== undefined ? { isolation: event.isolation } : {}),
    ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
    ...(event.lastAttemptReason !== undefined
      ? { lastAttemptReason: event.lastAttemptReason }
      : {}),
  };
  const nextProgress =
    existingIndex >= 0
      ? task.workflowProgress.map((current, position) =>
          position === existingIndex ? entry : current,
        )
      : [...task.workflowProgress, entry];
  const totalToolCalls = nextProgress.reduce(
    (sum, current) => (current.type === "workflow_agent" ? sum + (current.toolCalls ?? 0) : sum),
    0,
  );
  updateWorkflowTask(taskId, {
    workflowProgress: nextProgress,
    progressVersion: task.progressVersion + 1,
    totalToolCalls,
    ...(event.totalTokens !== undefined ? { totalTokens: event.totalTokens } : {}),
    ...(existingIndex < 0 ? { agentCount: task.agentCount + 1 } : {}),
  });
}

function recordWorkflowPhase(taskId: string, title: string): void {
  const task = getWorkflowTask(taskId);
  if (!task) return;
  const phase = task.phases?.find((candidate) => candidate.title === title);
  const index =
    phase?.index ?? task.workflowProgress.filter((entry) => entry.type === "workflow_phase").length;
  const entry: WorkflowProgressEntry = {
    type: "workflow_phase",
    index,
    title,
  };
  updateWorkflowTask(taskId, {
    workflowProgress: [...task.workflowProgress, entry],
    progressVersion: task.progressVersion + 1,
  });
}
