import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { compileWorkflowProgram } from "@/engine/background/workflows/runtime/compiler/compile.ts";
import { callsNonDeterministicApi } from "@/engine/background/workflows/runtime/compiler/determinism.ts";
import {
  loadWorkflowFromPath,
  persistWorkflowProgram,
  workflowTranscriptDir,
} from "@/engine/background/workflows/runtime/history/paths.ts";
import { WorkflowRunLedger } from "@/engine/background/workflows/runtime/history/run-ledger.ts";
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
  getListedWorkflows,
  resolveWorkflow,
} from "@/engine/background/workflows/runtime/registry/registry.ts";
import { cloneWorkflowBoundaryValue } from "@/engine/background/workflows/runtime/sandbox/clone.ts";
import {
  enrollWorkflowTask,
  getRunningWorkflowByRunId,
  listWorkflowTasks,
  removeWorkflowTask,
} from "@/engine/background/workflows/runtime/store/store.ts";
import type { WorkflowTaskLifecycle } from "@/engine/background/workflows/runtime/store/types.ts";
import { generateTaskId } from "@/kernel/std/id.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { runLaunchedWorkflow } from "./execute.ts";

export const WORKFLOW_RUN_ID_PATTERN = /^wf_[a-z0-9-]{6,}$/;

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
  if (isInlineScript && callsNonDeterministicApi(parsed.body)) {
    return {
      ok: false,
      error:
        "Workflow script uses Date.now(), Math.random(), Date(), or argless new Date(), which are unavailable because they break resume.",
    };
  }
  const compiled = compileWorkflowProgram(parsed.body);
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
  const transcriptDir = workflowTranscriptDir(ctx.cwd, ctx.sessionId, runId);
  await mkdir(transcriptDir, { recursive: true });
  const scriptPath =
    resolvedScriptPath ??
    (await persistWorkflowProgram({
      cwd: ctx.cwd,
      sessionId: ctx.sessionId,
      runId,
      workflowName: parsed.meta.name,
      script,
    }));
  const abortController = new AbortController();
  const summary = `Workflow "${parsed.meta.title ?? parsed.meta.name}" launched.`;
  const effectiveArgs = resolveEffectiveWorkflowArgs({ args, resume: resumeState });
  const task: WorkflowTaskLifecycle = {
    id: taskId,
    type: "local_workflow",
    status: "running",
    parentToolCallId,
    workflowRunId: runId,
    cwd: ctx.cwd,
    sessionId: ctx.sessionId,
    route: { provider: ctx.provider, model: ctx.model },
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
  enrollWorkflowTask(task);
  const vmArgs = task.args ?? null;
  const runLedger = new WorkflowRunLedger(transcriptDir);
  await runLedger.storeRecord({ type: "meta", args: vmArgs, scriptPath });
  await persistWorkflowRun({ cwd: ctx.cwd, sessionId: ctx.sessionId, runId, task });
  const recoveryIndex = await runLedger.recoverIndex();
  void runLaunchedWorkflow(taskId, compiled.vmScript, vmArgs, ctx, {
    persistRecord: (record) => runLedger.storeRecord(record),
    outputsByCacheKey: recoveryIndex.outputsByCacheKey,
    dispatchesByCacheKey: recoveryIndex.dispatchesByCacheKey,
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
  const transcriptDir = workflowTranscriptDir(options.cwd, options.sessionId, options.runId);
  const recoveryIndex = await new WorkflowRunLedger(transcriptDir).recoverIndex();
  const snapshot = await readWorkflowSnapshot(options);
  const runMetadata = recoveryIndex.runMetadata;
  if (runMetadata !== undefined) {
    const resumeScriptPath = runMetadata.scriptPath ?? snapshot?.scriptPath;
    return {
      argsPresent: true,
      args: runMetadata.args,
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
    const loaded = await loadWorkflowFromPath(cwd, resume.scriptPath);
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
    const loaded = await loadWorkflowFromPath(cwd, args.scriptPath);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    return { ok: true, source: { script: loaded.script, resolvedScriptPath: loaded.resolvedPath } };
  }
  if (typeof args.script === "string" && args.script.length > 0) {
    return { ok: true, source: { script: args.script } };
  }
  if (typeof args.name === "string" && args.name.length > 0) {
    const resolved = await resolveWorkflow(args.name, cwd);
    if (resolved) return { ok: true, source: { script: resolved.script } };
    const available = (await getListedWorkflows(cwd)).map((workflow) => workflow.name).join(", ");
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
