import { emitQueue } from "@/engine/queue/emit.ts";
import { agentTranscriptPathForCwd } from "@/engine/session/paths.ts";
import {
  type BackgroundTaskStatus,
  registerBackgroundTaskProvider,
} from "@/kernel/channels/background-tasks.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { generateTaskId } from "@/kernel/std/id.ts";
import type { EffortLevel } from "@/kernel/std/types/effort.ts";
import * as backgroundControllers from "./background-controllers.ts";
import * as taskRecords from "./index.ts";
import {
  buildAgentSummary,
  buildBashSummary,
  buildCompletionNotification,
} from "./notification.ts";
import {
  getTaskOutputPath,
  linkTaskOutput,
  resetTaskOutputPathPins,
  writeTaskOutputIfAbsent,
} from "./output-files.ts";

export interface BackgroundTaskAction {
  id: string;
  toolName: string;
  argsLabel: string;
  running: boolean;
  ts: number;
}

export type BackgroundTaskKind = "agent" | "shell";
export type AgentLifecycleMode = "linked" | "detached";
export type TerminalNotificationDestination = "pending" | "parent" | "owner" | "main" | "discarded";

export interface TaskRunRef {
  taskId: string;
  generation: number;
  token: string;
}

export interface BackgroundTask {
  id: string;
  kind: BackgroundTaskKind;
  parentToolCallId: string;
  parentTaskId?: string | undefined;
  spawnDepth?: number | undefined;
  depth?: number | undefined;
  hasLaterSibling?: boolean | undefined;
  transitiveHiddenCount?: number | undefined;
  agentName: string;
  agentId?: string;
  command?: string;
  description?: string;
  prompt?: string;
  provider?: ProviderId;
  model?: string;
  effort?: EffortLevel;
  runGeneration: number;
  runToken: string;
  lifecycleMode: AgentLifecycleMode;
  terminalNotification: TerminalNotificationDestination;
  reparentedGeneration?: number;
  cwd?: string;
  sessionId?: string;
  status: BackgroundTaskStatus;
  startedAt: number;
  endedAt?: number;
  isBackgrounded: boolean;
  isSidechain?: boolean;
  ownerId?: string;
  forkId?: string;
  backgroundedAt?: number;
  actions: BackgroundTaskAction[];
  assistantText: string;
  shellOutput: string;
  inputTokens: number;
  outputTokens: number;
  exitCode?: number;
  result?: { content: string; isError: boolean };
  notified: boolean;
  stoppedByUser?: boolean;
}

type Listener = () => void;
type CompletionListener = (task: BackgroundTask) => void;

const store = new Map<string, BackgroundTask>();
const completedOutputTokens = new Map<string, number>();
const listeners = new Set<Listener>();
const completionListeners = new Set<CompletionListener>();

const EMIT_THROTTLE_MS = 250;
let emitTimer: ReturnType<typeof setTimeout> | null = null;
let emitPending = false;
let runTokenCounter = 0;

function nextId(): string {
  return generateTaskId("a");
}

function nextRunToken(taskId: string, generation: number): string {
  runTokenCounter = (runTokenCounter + 1) | 0;
  return `${taskId}:${generation}:${runTokenCounter.toString(36)}`;
}

export function taskRunRef(task: BackgroundTask): TaskRunRef {
  return {
    taskId: task.id,
    generation: task.runGeneration,
    token: task.runToken,
  };
}

function taskMatchesRun(task: BackgroundTask | undefined, ref: TaskRunRef): task is BackgroundTask {
  return (
    task !== undefined &&
    task.id === ref.taskId &&
    task.runGeneration === ref.generation &&
    task.runToken === ref.token
  );
}

function emit(): void {
  if (emitTimer !== null) {
    emitPending = true;
    return;
  }
  for (const fn of listeners) fn();
  emitTimer = setTimeout(() => {
    emitTimer = null;
    if (emitPending) {
      emitPending = false;
      emit();
    }
  }, EMIT_THROTTLE_MS);
  (emitTimer as { unref?: () => void }).unref?.();
}

function cloneTask(task: BackgroundTask): BackgroundTask {
  return {
    ...task,
    actions: task.actions.map((action) => ({ ...action })),
    ...(task.result !== undefined ? { result: { ...task.result } } : {}),
  };
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function list(): BackgroundTask[] {
  return [...store.values()].sort((a, b) => a.startedAt - b.startedAt).map(cloneTask);
}

export function listRunning(): BackgroundTask[] {
  return list().filter((t) => t.status === "running");
}

export function hasRunningAgentDescendant(taskId: string): boolean {
  const pending = [taskId];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const parentId = pending.pop();
    if (parentId === undefined || seen.has(parentId)) continue;
    seen.add(parentId);
    for (const task of store.values()) {
      if (task.kind !== "agent" || task.parentTaskId !== parentId) continue;
      if (task.status === "running") return true;
      pending.push(task.id);
    }
  }
  return false;
}

export function get(id: string): BackgroundTask | undefined {
  const task = store.get(id);
  return task ? cloneTask(task) : undefined;
}

export function startTask(input: {
  parentToolCallId: string;
  parentTaskId?: string | undefined;
  spawnDepth?: number | undefined;
  agentName: string;
  agentId?: string;
  description?: string;
  prompt?: string;
  provider?: ProviderId;
  model?: string;
  cwd?: string;
  sessionId?: string;
  kind?: BackgroundTaskKind;
  isBackgrounded?: boolean;
  ownerId?: string;
  lifecycleMode?: AgentLifecycleMode;
}): BackgroundTask {
  const id = nextId();
  const runGeneration = 0;
  const task: BackgroundTask = {
    id,
    kind: input.kind ?? "agent",
    parentToolCallId: input.parentToolCallId,
    parentTaskId: input.parentTaskId,
    spawnDepth: input.spawnDepth,
    agentName: input.agentName,
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    runGeneration,
    runToken: nextRunToken(id, runGeneration),
    lifecycleMode: input.lifecycleMode ?? (input.isBackgrounded ? "detached" : "linked"),
    terminalNotification: "pending",
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
    status: "running",
    startedAt: Date.now(),
    isBackgrounded: input.isBackgrounded ?? false,
    ...(input.isBackgrounded ? { backgroundedAt: Date.now() } : {}),
    actions: [],
    assistantText: "",
    shellOutput: "",
    inputTokens: 0,
    outputTokens: 0,
    notified: false,
  };
  store.set(id, task);
  emit();
  return task;
}

export function startShellTask(input: {
  shellId: string;
  command: string;
  displayCommand?: string;
  parentToolCallId: string;
  isSidechain?: boolean;
  ownerId?: string;
  // Mid-run promotion (ctrl+b / auto-background) hands over a shell that has
  // already been running; the task must keep the original spawn time or the
  // elapsed display restarts from zero at the moment of promotion.
  startedAt?: number;
}): BackgroundTask {
  const task: BackgroundTask = {
    id: input.shellId,
    kind: "shell",
    parentToolCallId: input.parentToolCallId,
    agentName: "Bash",
    command: input.command,
    description: input.displayCommand ?? input.command,
    runGeneration: 0,
    runToken: nextRunToken(input.shellId, 0),
    lifecycleMode: "detached",
    terminalNotification: "pending",
    status: "running",
    startedAt: input.startedAt ?? Date.now(),
    isBackgrounded: true,
    ...(input.isSidechain ? { isSidechain: true } : {}),
    ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
    backgroundedAt: Date.now(),
    actions: [],
    assistantText: "",
    shellOutput: "",
    inputTokens: 0,
    outputTokens: 0,
    notified: false,
  };
  store.set(task.id, task);
  emit();
  return task;
}

export function markTaskNotifiedForRun(ref: TaskRunRef): boolean {
  const task = store.get(ref.taskId);
  if (!taskMatchesRun(task, ref) || task.notified) return false;
  task.notified = true;
  return true;
}

export function markTaskNotified(taskId: string): boolean {
  const task = store.get(taskId);
  return task === undefined ? false : markTaskNotifiedForRun(taskRunRef(task));
}

export const SHELL_OUTPUT_TAIL_CAP = 200_000;

export function appendShellOutput(taskId: string, text: string): void {
  if (!text) return;
  const task = store.get(taskId);
  if (!task) return;
  task.shellOutput += text;
  if (task.shellOutput.length > SHELL_OUTPUT_TAIL_CAP) {
    task.shellOutput = task.shellOutput.slice(-SHELL_OUTPUT_TAIL_CAP);
  }
  emit();
}

export interface TaskUsageDelta {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number | undefined;
  cacheReadInputTokens?: number | undefined;
}

// The input term is the FULL context size — input_tokens plus cache writes plus
// cache reads — kept at its latest value (input_tokens is cumulative-per-turn in
// the API, so the newest reading already covers prior context). Excluding cache
// made the counter swing with the provider's implicit cache: ~200k on a cache miss
// (whole prompt uncached) then ~10k once it warmed (delta only, the rest reported
// as cache_read), instead of tracking the stable context size.
function contextInputTokens(usage: TaskUsageDelta): number {
  return (
    usage.inputTokens + (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0)
  );
}

export function addUsage(taskId: string, usage: TaskUsageDelta): void {
  const task = store.get(taskId);
  if (!task) return;
  const contextInput = contextInputTokens(usage);
  if (contextInput > 0) task.inputTokens = contextInput;
  // Since turn is complete, outputTokens is turn-cumulative. Add to completed base.
  const baseOutput = completedOutputTokens.get(taskId) ?? 0;
  const newBase = baseOutput + usage.outputTokens;
  completedOutputTokens.set(taskId, newBase);
  task.outputTokens = newBase;
  emit();
}

export function setUsageSnapshot(taskId: string, usage: TaskUsageDelta): void {
  const task = store.get(taskId);
  if (!task) return;
  const contextInput = contextInputTokens(usage);
  if (contextInput > 0) task.inputTokens = contextInput;
  // Update task.outputTokens to the base of prior completed turns plus current turn's snapshot.
  const baseOutput = completedOutputTokens.get(taskId) ?? 0;
  task.outputTokens = baseOutput + usage.outputTokens;
  emit();
}

export function setModel(
  taskId: string,
  model: string,
  effort?: EffortLevel,
  provider?: ProviderId,
): void {
  const task = store.get(taskId);
  if (!task) return;
  task.model = model;
  if (effort !== undefined) task.effort = effort;
  if (provider !== undefined) task.provider = provider;
  emit();
}

export function setForkId(taskId: string, forkId: string): void {
  const task = store.get(taskId);
  if (!task || task.forkId !== undefined) return;
  task.forkId = forkId;
  linkAgentTaskOutput(task);
  emit();
}

function linkAgentTaskOutput(task: BackgroundTask): void {
  if (task.kind !== "agent") return;
  if (!task.cwd || !task.sessionId || !task.forkId) return;
  const transcriptPath = agentTranscriptPathForCwd(task.cwd, task.sessionId, task.forkId);
  void linkTaskOutput(task.id, transcriptPath).catch(() => {});
}

export function markBackgrounded(taskId: string): void {
  const task = store.get(taskId);
  if (!task) return;
  let changed = false;
  if (!task.isBackgrounded) {
    task.isBackgrounded = true;
    task.backgroundedAt = Date.now();
    changed = true;
  }
  if (task.kind === "agent" && task.lifecycleMode !== "detached") {
    task.lifecycleMode = "detached";
    changed = true;
  }
  if (changed) emit();
}

export function setTaskOwnerForRun(ref: TaskRunRef, ownerId: string | undefined): boolean {
  const task = store.get(ref.taskId);
  if (!taskMatchesRun(task, ref)) return false;
  if (ownerId === undefined) delete task.ownerId;
  else task.ownerId = ownerId;
  emit();
  return true;
}

export function setTaskOwner(taskId: string, ownerId: string | undefined): void {
  const task = store.get(taskId);
  if (task !== undefined) setTaskOwnerForRun(taskRunRef(task), ownerId);
}

export function markOwnerNotificationsPromoted(
  ownerId: string,
  replayKeys: readonly string[],
): void {
  const promoted = new Set(replayKeys);
  let changed = false;
  for (const task of store.values()) {
    if (
      task.ownerId !== ownerId ||
      task.terminalNotification !== "owner" ||
      !promoted.has(`bg:${task.id}:${task.runGeneration}`)
    ) {
      continue;
    }
    task.terminalNotification = "main";
    releaseOwnerNotificationRetention(taskRunRef(task));
    changed = true;
  }
  if (changed) emit();
}

export function detachTaskForRun(ref: TaskRunRef): boolean {
  const task = store.get(ref.taskId);
  if (!taskMatchesRun(task, ref) || task.kind !== "agent") return false;
  if (task.lifecycleMode === "detached") return true;
  task.lifecycleMode = "detached";
  task.isBackgrounded = true;
  task.backgroundedAt ??= Date.now();
  emit();
  return true;
}

export function listBackgrounded(): BackgroundTask[] {
  return list().filter((t) => t.isBackgrounded);
}

export function appendAction(taskId: string, action: BackgroundTaskAction): void {
  const task = store.get(taskId);
  if (!task) return;
  task.actions.push(action);
  emit();
}

export function appendAssistantText(taskId: string, text: string): void {
  const task = store.get(taskId);
  if (!task || text.length === 0) return;
  task.assistantText += text;
  emit();
}

export function discardAssistantText(taskId: string, chars: number): void {
  // fork_stream_reset: trim the voided attempt's tail so TaskOutput on a
  // still-running task never surfaces doubled text to the model.
  const task = store.get(taskId);
  if (!task || chars <= 0) return;
  task.assistantText = task.assistantText.slice(0, Math.max(0, task.assistantText.length - chars));
  emit();
}

export function completeAction(taskId: string, actionId: string): void {
  endRunningAction(taskId, actionId, false);
}

export function failAction(taskId: string, actionId: string): void {
  endRunningAction(taskId, actionId, true);
}

function endRunningAction(taskId: string, actionId: string, isError: boolean): void {
  const task = store.get(taskId);
  if (!task) return;
  for (let i = task.actions.length - 1; i >= 0; i--) {
    const action = task.actions[i];
    if (action && action.id === actionId && action.running) {
      action.running = false;
      if (isError) action.argsLabel = `${action.argsLabel} ⚠`;
      break;
    }
  }
  emit();
}

const EVICT_DELAY_MS = 30_000;
let evictDelayMs = EVICT_DELAY_MS;
const evictionHolds = new Map<string, number>();
const pendingEvictions = new Map<string, TaskRunRef>();
const ownerNotificationRetentions = new Map<string, TaskRunRef>();
const evictionTimers = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; generation: number; token: string }
>();

export function setEvictionDelayForTests(ms: number): void {
  evictDelayMs = ms;
}

export function resetEmitThrottleForTests(): void {
  if (emitTimer !== null) clearTimeout(emitTimer);
  emitTimer = null;
  emitPending = false;
}

export function holdTaskEviction(taskId: string): () => void {
  evictionHolds.set(taskId, (evictionHolds.get(taskId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (evictionHolds.get(taskId) ?? 1) - 1;
    if (n > 0) {
      evictionHolds.set(taskId, n);
      return;
    }
    evictionHolds.delete(taskId);
    const pending = pendingEvictions.get(taskId);
    if (pending !== undefined) evictTaskForRun(pending);
  };
}

function retainOwnerNotification(task: BackgroundTask): void {
  if (
    task.kind !== "agent" ||
    task.parentTaskId === undefined ||
    task.terminalNotification !== "owner" ||
    store.get(task.parentTaskId)?.status !== "running"
  ) {
    return;
  }
  ownerNotificationRetentions.set(task.id, taskRunRef(task));
}

function releaseOwnerNotificationRetention(ref: TaskRunRef): void {
  const retained = ownerNotificationRetentions.get(ref.taskId);
  if (retained?.generation !== ref.generation || retained.token !== ref.token) return;
  ownerNotificationRetentions.delete(ref.taskId);
  const pending = pendingEvictions.get(ref.taskId);
  if (pending?.generation === ref.generation && pending.token === ref.token) {
    evictTaskForRun(pending);
  }
}

function releaseChildNotificationRetentions(parentTaskId: string): void {
  for (const child of store.values()) {
    if (child.parentTaskId === parentTaskId) {
      releaseOwnerNotificationRetention(taskRunRef(child));
    }
  }
}

function evictTaskForRun(ref: TaskRunRef): void {
  const pending = pendingEvictions.get(ref.taskId);
  if (pending !== undefined && pending.token === ref.token) pendingEvictions.delete(ref.taskId);
  const task = store.get(ref.taskId);
  if (!taskMatchesRun(task, ref)) return;
  if (task.status === "running") return;
  const retained = ownerNotificationRetentions.get(ref.taskId);
  if (retained?.generation === ref.generation && retained.token === ref.token) {
    pendingEvictions.set(ref.taskId, ref);
    return;
  }
  if (evictionHolds.has(ref.taskId)) {
    pendingEvictions.set(ref.taskId, ref);
    return;
  }
  store.delete(ref.taskId);
  ownerNotificationRetentions.delete(ref.taskId);
  completedOutputTokens.delete(ref.taskId);
  emit();
  // Eviction releases in-memory state ONLY. The on-disk .log must survive: the
  // completion notification advertises its path and the model may Read it
  // minutes later. The session tmp dir is removed on process exit.
}

function scheduleEviction(ref: TaskRunRef): void {
  const existing = evictionTimers.get(ref.taskId);
  if (existing !== undefined) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    const current = evictionTimers.get(ref.taskId);
    if (current?.token !== ref.token || current.generation !== ref.generation) return;
    evictionTimers.delete(ref.taskId);
    evictTaskForRun(ref);
  }, evictDelayMs);
  evictionTimers.set(ref.taskId, { timer, generation: ref.generation, token: ref.token });
  (timer as { unref?: () => void }).unref?.();
}

// Puts a finished task back into `running` for an agent-view resume. Its
// pending eviction is cancelled; `notified` resets for the resumed completion.
function prepareTaskForResume(task: BackgroundTask): void {
  task.status = "running";
  task.runGeneration += 1;
  task.runToken = nextRunToken(task.id, task.runGeneration);
  task.lifecycleMode = "detached";
  task.terminalNotification = "pending";
  delete task.reparentedGeneration;
  task.startedAt = Date.now();
  delete task.endedAt;
  delete task.exitCode;
  delete task.stoppedByUser;
  delete task.result;
  // The resumed run streams fresh output; stale text from the previous run
  // must not surface through TaskOutput or prefix the new deltas.
  task.assistantText = "";
  task.notified = false;
}

export function reopenTask(taskId: string): BackgroundTask | undefined {
  const task = store.get(taskId);
  if (!task || task.status === "running") return undefined;
  ownerNotificationRetentions.delete(taskId);
  prepareTaskForResume(task);
  pendingEvictions.delete(taskId);
  const timer = evictionTimers.get(taskId);
  if (timer !== undefined) {
    clearTimeout(timer.timer);
    evictionTimers.delete(taskId);
  }
  emit();
  return cloneTask(task);
}

export function restoreTaskForResume(snapshot: BackgroundTask): BackgroundTask | undefined {
  if (store.has(snapshot.id) || snapshot.status === "running") return undefined;
  const restored = cloneTask(snapshot);
  ownerNotificationRetentions.delete(restored.id);
  prepareTaskForResume(restored);
  pendingEvictions.delete(restored.id);
  const timer = evictionTimers.get(restored.id);
  if (timer !== undefined) {
    clearTimeout(timer.timer);
    evictionTimers.delete(restored.id);
  }
  store.set(restored.id, restored);
  linkAgentTaskOutput(restored);
  emit();
  return cloneTask(restored);
}

export interface TaskCompletion {
  content: string;
  isError: boolean;
  killed?: boolean;
  exitCode?: number;
  userInitiated?: boolean;
}

export interface CancelTaskTreeOptions {
  reason: string;
  userInitiated?: boolean;
  includeDetached?: boolean;
  suppressRootNotification?: boolean;
}

export function completeTaskForRun(ref: TaskRunRef, result: TaskCompletion): boolean {
  if (result.killed === true) {
    return cancelTaskTree(ref, {
      reason: result.content,
      ...(result.userInitiated === true ? { userInitiated: true } : {}),
    });
  }
  return finishTaskForRun(ref, result);
}

export function completeTask(taskId: string, result: TaskCompletion): void {
  const task = store.get(taskId);
  if (task !== undefined) completeTaskForRun(taskRunRef(task), result);
}

function finishTaskForRun(
  ref: TaskRunRef,
  result: TaskCompletion,
  terminalNotification?: TerminalNotificationDestination,
  allowTerminal = false,
): boolean {
  const task = store.get(ref.taskId);
  if (!taskMatchesRun(task, ref) || (!allowTerminal && task.status !== "running")) return false;
  if (allowTerminal && task.status === "killed") return false;

  task.status = result.killed ? "killed" : result.isError ? "error" : "completed";
  task.endedAt = Date.now();
  if (result.exitCode !== undefined) task.exitCode = result.exitCode;
  if (result.userInitiated === true) task.stoppedByUser = true;
  task.result = { content: result.content, isError: result.isError };

  if (terminalNotification !== undefined) {
    task.terminalNotification = terminalNotification;
    task.notified = true;
  } else if (task.kind === "agent" && task.lifecycleMode === "linked") {
    // Foreground results are returned through the Agent tool result boundary.
    // They never also become asynchronous owner/main notifications.
    task.terminalNotification = "parent";
    task.notified = true;
  } else if (task.isBackgrounded) {
    routeBackgroundedNotification(ref);
  }

  if (task.terminalNotification === "owner") retainOwnerNotification(task);
  else releaseOwnerNotificationRetention(ref);
  releaseChildNotificationRetentions(task.id);
  emit();
  const snapshot = cloneTask(task);
  for (const fn of completionListeners) fn(snapshot);
  scheduleEviction(ref);
  return true;
}

export function taskFinalStatus(status: string): "completed" | "failed" | "killed" {
  if (status === "killed") return "killed";
  if (status === "error" || status === "failed") return "failed";
  return "completed";
}

function routeBackgroundedNotification(ref: TaskRunRef): void {
  const task = store.get(ref.taskId);
  if (!taskMatchesRun(task, ref) || task.notified) return;
  task.notified = true;
  const status = taskFinalStatus(task.status);
  const description = task.description ?? task.agentName;
  const isAgent = task.kind === "agent";
  const failureError = status === "failed" ? task.result?.content : undefined;
  const byUser = status === "killed" && task.stoppedByUser === true;
  const summary = isAgent
    ? buildAgentSummary(description, status, {
        ...(failureError !== undefined ? { error: failureError } : {}),
        byUser,
      })
    : buildBashSummary(description, status, {
        ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
        byUser,
      });
  const agentResult = isAgent && status === "completed" ? task.result?.content : undefined;
  const notificationText = buildCompletionNotification({
    taskId: task.id,
    toolUseId: task.parentToolCallId,
    outputFile: getTaskOutputPath(task.id),
    status,
    summary,
    ...(agentResult !== undefined && agentResult.length > 0 ? { result: agentResult } : {}),
  });
  const notificationId = emitQueue.emitForCompletion({
    class: "deferred_output",
    ownerId: task.ownerId,
    isSubagentOwned: task.ownerId !== undefined,
    payload: { kind: "task_notification_xml", text: notificationText, summary },
    replayKey: `bg:${task.id}:${task.runGeneration}`,
  });
  const queued = emitQueue.peek().find((item) => item.id === notificationId);
  task.terminalNotification = queued?.target === "inventory" ? "owner" : "main";
  void writeTaskOutputIfAbsent(task.id, task.result?.content ?? "").catch(() => {});
}

function reparentDetachedRun(ref: TaskRunRef): boolean {
  const task = store.get(ref.taskId);
  if (
    !taskMatchesRun(task, ref) ||
    task.lifecycleMode !== "detached" ||
    task.reparentedGeneration === ref.generation
  ) {
    return false;
  }
  task.reparentedGeneration = ref.generation;
  delete task.ownerId;
  const replayKey = `bg:${ref.taskId}:${ref.generation}`;
  const reparented = emitQueue.reparent((item) => item.replayKey === replayKey, undefined);
  if (task.terminalNotification === "owner") {
    if (reparented === 0) {
      task.notified = false;
      routeBackgroundedNotification(ref);
    } else {
      task.terminalNotification = "main";
    }
  }
  releaseOwnerNotificationRetention(ref);
  emit();
  return true;
}

export function cancelTaskTree(ref: TaskRunRef, options: CancelTaskTreeOptions): boolean {
  const root = store.get(ref.taskId);
  if (!taskMatchesRun(root, ref)) return false;
  const visited = new Set<string>();
  let changed = false;

  const visit = (taskRef: TaskRunRef, isRoot: boolean, forceDetached: boolean): void => {
    const task = store.get(taskRef.taskId);
    if (!taskMatchesRun(task, taskRef) || visited.has(task.id)) return;
    visited.add(task.id);
    const wasParked = task.status === "completed" && hasRunningAgentDescendant(task.id);

    for (const child of store.values()) {
      if (child.kind !== "agent" || child.parentTaskId !== task.id) continue;
      const childRef = taskRunRef(child);
      if (!forceDetached && child.lifecycleMode === "detached") {
        changed = reparentDetachedRun(childRef) || changed;
        continue;
      }
      visit(childRef, false, forceDetached);
    }

    const canStop =
      task.status === "running" || (options.includeDetached === true && (isRoot || wasParked));
    if (!canStop) return;
    const suppress =
      !isRoot || options.suppressRootNotification === true || task.lifecycleMode === "linked";
    if (suppress) {
      emitQueue.cancel(
        (item) => item.replayKey === `bg:${task.id}:${task.runGeneration}`,
        "ancestor-cancelled",
      );
    }
    const stopped = finishTaskForRun(
      taskRef,
      {
        content: options.reason,
        isError: false,
        killed: true,
        ...(options.userInitiated === true ? { userInitiated: true } : {}),
      },
      suppress ? "discarded" : undefined,
      options.includeDetached === true,
    );
    if (!stopped) return;
    changed = true;
    const controller = backgroundControllers.get(task.parentToolCallId);
    if (controller?.taskId === task.id) {
      controller.abort?.();
      backgroundControllers.unregister(task.parentToolCallId, controller);
    }
  };

  visit(ref, true, options.includeDetached === true);
  return changed;
}

export function subscribeCompletion(fn: CompletionListener): () => void {
  completionListeners.add(fn);
  return () => {
    completionListeners.delete(fn);
  };
}

export function removeTask(taskId: string): boolean {
  if (store.has(taskId)) releaseChildNotificationRetentions(taskId);
  const ok = store.delete(taskId);
  completedOutputTokens.delete(taskId);
  pendingEvictions.delete(taskId);
  ownerNotificationRetentions.delete(taskId);
  const timer = evictionTimers.get(taskId);
  if (timer !== undefined) clearTimeout(timer.timer);
  evictionTimers.delete(taskId);
  if (ok) emit();
  return ok;
}

export function clear(): void {
  store.clear();
  completedOutputTokens.clear();
  evictionHolds.clear();
  pendingEvictions.clear();
  ownerNotificationRetentions.clear();
  for (const entry of evictionTimers.values()) clearTimeout(entry.timer);
  evictionTimers.clear();
  runTokenCounter = 0;
  resetTaskOutputPathPins();
  emit();
}

export function registerBackgroundTaskKernelProvider(): void {
  registerBackgroundTaskProvider({
    list: () => taskRecords.list() as never,
    subscribe: (fn) => taskRecords.subscribe(fn),
    subscribeCompletion: (fn) => subscribeCompletion((task) => fn(task as never)),
  });
}

registerBackgroundTaskKernelProvider();
