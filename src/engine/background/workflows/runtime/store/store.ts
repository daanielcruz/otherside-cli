import {
  buildCompletionNotification,
  buildWorkflowSummary,
  type TaskNotificationStatus,
} from "@/engine/background/tasks/notification.ts";
import { getWorkflowTranscriptDir } from "@/engine/background/workflows/runtime/history/paths.ts";
import { persistWorkflowRun } from "@/engine/background/workflows/runtime/history/snapshot.ts";
import type {
  LocalWorkflowTaskState,
  WorkflowAgentControlReason,
  WorkflowProgressEntry,
} from "@/engine/background/workflows/runtime/store/types.ts";
import {
  WORKFLOW_AGENT_RETRY_REASON,
  WORKFLOW_AGENT_SKIP_REASON,
} from "@/engine/background/workflows/runtime/store/types.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import {
  registerWorkflowTasksProvider,
  type WorkflowTaskStatus,
} from "@/kernel/channels/workflow-tasks.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";

/** Matches `[]` / `{}` / `{"key": []}` result previews for the empty-result count. */
const EMPTY_RESULT_PREVIEW_RE = /^(\[\s*\]|\{\s*\}|\{\s*"[^"]+"\s*:\s*\[\s*\]\s*\})$/;

const tasks = new Map<string, LocalWorkflowTaskState>();
const listeners = new Set<() => void>();
type WorkflowCompletionListener = (task: LocalWorkflowTaskState) => void;
const completionListeners = new Set<WorkflowCompletionListener>();
const evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();
const persistenceByRunId = new Map<string, Promise<void>>();

// Fires once when a workflow reaches a terminal status — the seam the React
// layer uses to roll the run's token usage into the session ledger (the store
// has no knowledge of recordProviderUsage, so no circular import).
export function subscribeWorkflowCompletion(fn: WorkflowCompletionListener): () => void {
  completionListeners.add(fn);
  return () => {
    completionListeners.delete(fn);
  };
}

const NOTIFY_THROTTLE_MS = 250;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let notifyPending = false;

const EVICT_DELAY_MS = 30_000;
let evictDelayMs = EVICT_DELAY_MS;

export function setWorkflowEvictionDelayForTests(ms: number): void {
  evictDelayMs = ms;
}

function isTerminalWorkflowStatus(status: WorkflowTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}

function evictWorkflowTask(taskId: string): void {
  const task = tasks.get(taskId);
  if (!task) return;
  if (!isTerminalWorkflowStatus(task.status)) return;
  tasks.delete(taskId);
  notifyWorkflowTaskListeners();
}

function scheduleWorkflowEviction(taskId: string): void {
  if (evictionTimers.has(taskId)) {
    clearTimeout(evictionTimers.get(taskId));
  }
  const timer = setTimeout(() => {
    evictionTimers.delete(taskId);
    evictWorkflowTask(taskId);
  }, evictDelayMs);
  timer.unref?.();
  evictionTimers.set(taskId, timer);
}

export function registerWorkflowTask(task: LocalWorkflowTaskState): void {
  tasks.set(task.id, task);
  notifyWorkflowTaskListeners();
}

export function getWorkflowTask(taskId: string): LocalWorkflowTaskState | undefined {
  return tasks.get(taskId);
}

export function getRunningWorkflowByRunId(runId: string): LocalWorkflowTaskState | undefined {
  return [...tasks.values()].find(
    (task) => task.workflowRunId === runId && task.status === "running",
  );
}

export function getWorkflowTaskByParentToolCallId(
  parentToolCallId: string,
): LocalWorkflowTaskState | undefined {
  return [...tasks.values()].find((task) => task.parentToolCallId === parentToolCallId);
}

export function removeWorkflowTask(taskId: string): boolean {
  if (evictionTimers.has(taskId)) {
    clearTimeout(evictionTimers.get(taskId));
    evictionTimers.delete(taskId);
  }
  const existed = tasks.has(taskId);
  tasks.delete(taskId);
  if (existed) notifyWorkflowTaskListeners();
  return existed;
}

export function listWorkflowTasks(): LocalWorkflowTaskState[] {
  return [...tasks.values()].sort((left, right) => right.startedAt - left.startedAt);
}

/**
 * Distinct routing providers of stage agents currently executing in running
 * workflows. Stage agents never enter the background-task store, so this is
 * their only allocation signal for passive quota warnings.
 */
export function listActiveWorkflowAgentProviders(): ProviderId[] {
  const providers = new Set<ProviderId>();
  for (const task of tasks.values()) {
    if (task.status !== "running") continue;
    for (const entry of task.workflowProgress) {
      if (entry.type !== "workflow_agent") continue;
      if (entry.state !== "start") continue;
      if (entry.provider !== undefined) providers.add(entry.provider);
    }
  }
  return [...providers];
}

export function subscribeWorkflowTasks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateWorkflowTask(
  taskId: string,
  patch: Partial<Omit<LocalWorkflowTaskState, "id">>,
): LocalWorkflowTaskState | undefined {
  const task = tasks.get(taskId);
  if (!task) return undefined;
  Object.assign(task, patch);
  notifyWorkflowTaskListeners();
  return task;
}

export function completeWorkflowTask(taskId: string, result: unknown, outputFile: string): void {
  finishWorkflowTask(taskId, { status: "completed", result, outputFile });
}

export function failWorkflowTask(taskId: string, error: string, outputFile: string): void {
  finishWorkflowTask(taskId, { status: "failed", error, outputFile });
}

export function killWorkflowTask(taskId: string, userInitiated = false): boolean {
  const task = tasks.get(taskId);
  if (!task) return false;
  task.abortController.abort();
  finishWorkflowTask(taskId, {
    status: "killed",
    error: "Workflow was stopped",
    ...(userInitiated ? { stoppedByUser: true } : {}),
  });
  return true;
}

export function pauseWorkflowTask(taskId: string): boolean {
  const task = tasks.get(taskId);
  if (!task) return false;
  if (task.status !== "running") return false;
  task.abortController.abort();
  task.agentControllers?.clear();
  const patch: Partial<Omit<LocalWorkflowTaskState, "id">> = {
    status: "paused",
    endedAt: Date.now(),
  };
  Object.assign(task, patch);
  notifyWorkflowTaskListeners();
  enqueueWorkflowPersistence(task);
  return true;
}

export function skipWorkflowAgent(agentId: string): boolean {
  return abortWorkflowAgent(agentId, WORKFLOW_AGENT_SKIP_REASON);
}

export function retryWorkflowAgent(agentId: string): boolean {
  return abortWorkflowAgent(agentId, WORKFLOW_AGENT_RETRY_REASON);
}

function abortWorkflowAgent(agentId: string, reason: WorkflowAgentControlReason): boolean {
  for (const task of tasks.values()) {
    if (task.status !== "running") continue;
    const controller = task.agentControllers?.get(agentId);
    if (controller && !controller.signal.aborted) {
      controller.abort(reason);
      return true;
    }
  }
  return false;
}

export function resetWorkflowTasksForTests(): void {
  for (const timer of evictionTimers.values()) {
    clearTimeout(timer);
  }
  evictionTimers.clear();
  if (notifyTimer !== null) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
  notifyPending = false;
  evictDelayMs = EVICT_DELAY_MS;
  persistenceByRunId.clear();
  tasks.clear();
  notifyWorkflowTaskListeners();
}

function enqueueWorkflowPersistence(task: LocalWorkflowTaskState): void {
  const runId = task.workflowRunId;
  const previous = persistenceByRunId.get(runId) ?? Promise.resolve();
  const next = previous.then(() =>
    persistWorkflowRun({
      cwd: task.cwd,
      sessionId: task.sessionId,
      runId,
      task,
    }),
  );
  persistenceByRunId.set(runId, next);
  void next.then(() => {
    if (persistenceByRunId.get(runId) === next) persistenceByRunId.delete(runId);
  });
}

function finishWorkflowTask(
  taskId: string,
  patch: Partial<Omit<LocalWorkflowTaskState, "id">> & { status: WorkflowTaskStatus },
): void {
  const task = tasks.get(taskId);
  if (!task) return;
  if (isTerminalWorkflowStatus(task.status)) return;
  Object.assign(task, patch, { endedAt: Date.now() });
  task.agentControllers?.clear();
  notifyWorkflowTaskListeners();
  enqueueWorkflowPersistence(task);
  for (const fn of completionListeners) fn(task);
  routeWorkflowCompletionNotification(task);
  scheduleWorkflowEviction(taskId);
}

function routeWorkflowCompletionNotification(task: LocalWorkflowTaskState): void {
  const status = terminalNotificationStatus(task.status);
  if (status === null) return;
  // A user-stopped workflow is silent: the user just watched themselves stop
  // it, and the model must not react to that decision. Model/parent stops and
  // organic terminals still notify.
  if (status === "killed" && task.stoppedByUser === true) return;
  const rawResult = status === "completed" ? workflowResultText(task.result) : undefined;
  const result =
    rawResult !== undefined ? truncateWorkflowResult(rawResult, task.outputFile) : undefined;
  const byUser = status === "killed" && task.stoppedByUser === true;
  const summary = buildWorkflowSummary(task.description, status, {
    ...(task.error !== undefined ? { error: task.error } : {}),
    byUser,
  });
  const transcriptDir = getWorkflowTranscriptDir(task.cwd, task.sessionId, task.workflowRunId);
  const recovery = composeRecoveryGuidance(task, status, transcriptDir);
  const diagnostics = composeDiagnosticsGuidance(task, status, transcriptDir);
  const durationMs = task.endedAt !== undefined ? Math.max(0, task.endedAt - task.startedAt) : 0;
  const agents = countWorkflowAgentOutcomes(task.workflowProgress);
  const failures =
    task.failures !== undefined && task.failures.length > 0 ? task.failures : undefined;
  const notificationText = buildCompletionNotification({
    taskId: task.id,
    toolUseId: task.parentToolCallId,
    status,
    summary,
    ...(status === "failed" && task.error !== undefined ? { error: task.error } : {}),
    ...(task.outputFile !== undefined ? { outputFile: task.outputFile } : {}),
    ...(recovery !== undefined ? { recovery } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(diagnostics !== undefined ? { diagnostics } : {}),
    ...(failures !== undefined ? { failures } : {}),
    usage: {
      totalTokens: task.totalTokens,
      toolUses: task.totalToolCalls,
      durationMs,
      agentCount: task.agentCount,
      agents,
    },
  });
  // Model-stopped and organically-terminal workflows nudge an idle session
  // into a fresh turn; user stops were filtered out above.
  emitQueue.emitForCompletion({
    class: "urgent_output",
    ownerId: task.ownerId,
    isSubagentOwned: task.ownerId !== undefined,
    payload: { kind: "task_notification_xml", text: notificationText, summary },
    replayKey: `wf:${task.id}`,
  });
}

function composeRecoveryGuidance(
  task: LocalWorkflowTaskState,
  status: TaskNotificationStatus,
  transcriptDir: string,
): string | undefined {
  if (status !== "failed" && status !== "killed") return undefined;
  const lines: string[] = [];
  if (task.scriptPath !== undefined && task.scriptPath.length > 0) {
    lines.push(resumeWorkflowCallLine(task, "resume"));
  }
  lines.push(`Agent transcripts: ${transcriptDir}`);
  return lines.join("\n");
}

function composeDiagnosticsGuidance(
  task: LocalWorkflowTaskState,
  status: TaskNotificationStatus,
  transcriptDir: string,
): string | undefined {
  if (status !== "completed") return undefined;
  const lines: string[] = [
    `Per-agent results: ${transcriptDir}/journal.jsonl — one {"type":"result",...} line per completed agent with its full return value.`,
    "If the result above is empty or unexpected, Read this file BEFORE diagnosing — do not assume agents returned non-empty results.",
  ];
  if (task.scriptPath !== undefined && task.scriptPath.length > 0) {
    lines.push(resumeWorkflowCallLine(task, "rerun"));
  }
  return lines.join("\n");
}

// Shared with the /workflows detail panel, which injects this same call as a
// one-shot resume prompt when the user resumes a paused run from the UI.
export function buildWorkflowResumeCall(input: {
  scriptPath: string;
  runId: string;
  args?: unknown;
}): string {
  const argsPart = input.args !== undefined ? `, args: ${JSON.stringify(input.args)}` : "";
  return `Workflow({scriptPath: ${JSON.stringify(input.scriptPath)}, resumeFromRunId: ${JSON.stringify(input.runId)}${argsPart}})`;
}

function resumeWorkflowCallLine(task: LocalWorkflowTaskState, mode: "resume" | "rerun"): string {
  const call = buildWorkflowResumeCall({
    scriptPath: task.scriptPath ?? "",
    runId: task.workflowRunId,
    args: task.args,
  });
  if (mode === "rerun") {
    return `To re-run with edited post-processing: ${call} — agents whose (prompt, opts) are unchanged replay from cache.`;
  }
  return `To resume after editing the script, call: ${call}`;
}

function countWorkflowAgentOutcomes(progress: WorkflowProgressEntry[]): {
  done: number;
  error: number;
  skipped: number;
  emptyResult: number;
} {
  let done = 0;
  let error = 0;
  let skipped = 0;
  let emptyResult = 0;
  for (const entry of progress) {
    if (entry.type !== "workflow_agent") continue;
    if (entry.state === "done") {
      done++;
      if (entry.resultPreview === undefined || EMPTY_RESULT_PREVIEW_RE.test(entry.resultPreview)) {
        emptyResult++;
      }
    } else if (entry.state === "error") {
      if (entry.skipped === true) skipped++;
      else error++;
    }
  }
  return { done, error, skipped, emptyResult };
}

function terminalNotificationStatus(status: WorkflowTaskStatus): TaskNotificationStatus | null {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "killed") return "killed";
  return null;
}

const WORKFLOW_RESULT_MAX_CHARS = 8000;

function workflowResultText(result: unknown): string | undefined {
  if (result === undefined) return undefined;
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return undefined;
  }
}

export function truncateWorkflowResult(result: string, outputFile: string | undefined): string {
  if (result.length <= WORKFLOW_RESULT_MAX_CHARS) return result;
  const dropped = result.length - WORKFLOW_RESULT_MAX_CHARS;
  const location = outputFile ? `, full result in ${outputFile}` : "";
  return `${result.slice(0, WORKFLOW_RESULT_MAX_CHARS)}\n... (truncated ${dropped} chars${location})`;
}

function notifyWorkflowTaskListeners(): void {
  if (notifyTimer !== null) {
    notifyPending = true;
    return;
  }
  for (const listener of listeners) listener();
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    if (notifyPending) {
      notifyPending = false;
      notifyWorkflowTaskListeners();
    }
  }, NOTIFY_THROTTLE_MS);
  notifyTimer.unref?.();
}

registerWorkflowTasksProvider({
  list: () => listWorkflowTasks(),
  subscribe: subscribeWorkflowTasks,
});
