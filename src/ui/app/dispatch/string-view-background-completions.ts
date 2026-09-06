import {
  type BackgroundTask,
  list as listBackgroundTasks,
  subscribeCompletion as subscribeBackgroundCompletion,
  subscribe as subscribeBackgroundTasks,
  taskFinalStatus,
} from "@/engine/background/tasks/background.ts";
import { subscribeWorkflowCompletion } from "@/engine/background/workflows/runtime/store/store.ts";
import type { WorkflowTaskLifecycle } from "@/engine/background/workflows/runtime/store/types.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import { applyAgentIdentityToTranscript } from "@/engine/session/record/transcript-update.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import { getTranscriptEntries, transcriptActions } from "@/store/transcript/index.ts";
import { compactRunningRef, runningRef } from "@/store/turn-run/index.ts";
import { elapsedMs } from "@/ui/transcript/stats.ts";

export function workflowNoticeReplayKey(taskId: string): string {
  return `wf:${taskId}`;
}

export function backgroundTaskNoticeIdentity(taskId: string, runGeneration: number): string {
  return `bg:${taskId}:${runGeneration}`;
}

export function backgroundTaskNoticeData(task: BackgroundTask): Record<string, unknown> {
  const status = taskFinalStatus(task.status);
  return {
    taskKind: task.kind,
    status,
    description: task.description ?? task.agentName,
    durationMs: task.endedAt !== undefined ? task.endedAt - task.startedAt : 0,
    taskId: task.id,
    ...(task.kind === "shell" && task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
    ...(task.kind === "agent" && status === "failed" && task.error !== undefined
      ? { error: task.error }
      : {}),
  };
}

export function workflowTaskNoticeData(task: WorkflowTaskLifecycle): Record<string, unknown> {
  const status = taskFinalStatus(task.status);
  return {
    taskKind: "workflow",
    status,
    description: task.title ?? task.description ?? task.workflowName,
    durationMs: elapsedMs(task.startedAt, task.endedAt),
    taskId: task.id,
    ...(status === "failed" && task.error !== undefined ? { error: task.error } : {}),
  };
}

/**
 * The notification queue as this projection needs it: when a completion reached
 * the model, whether one is still waiting, and when either fact changes.
 */
export interface CompletionQueueBridge {
  wasReplayKeyConsumed: (replayKey: string) => boolean;
  hasPendingAutoTurn: () => boolean;
  subscribe: (listener: () => void) => () => void;
  onDrain: (listener: () => void) => () => void;
}

const LIVE_QUEUE_BRIDGE: CompletionQueueBridge = {
  wasReplayKeyConsumed: (replayKey) => emitQueue.wasReplayKeyConsumed(replayKey),
  hasPendingAutoTurn: () => emitQueue.hasPendingAutoTurn(),
  subscribe: (listener) => emitQueue.subscribe(() => listener()),
  onDrain: (listener) => emitQueue.onDrain(() => listener()),
};

export interface StringViewBackgroundCompletionDeps {
  requestRepaint: () => void;
  /** The single resume driver; called only while the turn is terminally idle. */
  requestBackgroundResume?: () => void;
  queue?: CompletionQueueBridge;
  isTurnBusy?: () => boolean;
  listBackgroundTasks?: () => BackgroundTask[];
  subscribeBackgroundTasks?: (listener: () => void) => () => void;
  subscribeBackgroundCompletion?: (listener: (task: BackgroundTask) => void) => () => void;
  subscribeWorkflowCompletion?: (listener: (task: WorkflowTaskLifecycle) => void) => () => void;
  getTranscriptEntries?: () => readonly TranscriptEntry[];
  updateTranscript?: (
    updater: (entries: readonly TranscriptEntry[]) => readonly TranscriptEntry[],
  ) => void;
}

function applyBackgroundAgentIdentities(
  tasks: readonly BackgroundTask[],
  entries: readonly TranscriptEntry[],
): readonly TranscriptEntry[] {
  let next = entries;
  for (const task of tasks) {
    if (task.kind !== "agent" || !task.isBackgrounded || !task.model) continue;
    next = applyAgentIdentityToTranscript(next, task.parentToolCallId, {
      model: task.model,
      ...(task.provider !== undefined ? { provider: task.provider } : {}),
      ...(task.agentName ? { name: task.agentName } : {}),
    });
  }
  return next;
}

function backgroundNoticeEntry(task: BackgroundTask): TranscriptEntry {
  const notice = backgroundTaskNoticeData(task);
  const identity = backgroundTaskNoticeIdentity(task.id, task.runGeneration);
  return {
    id: `n_${identity}`,
    kind: "task_notice",
    text: JSON.stringify(notice),
    isError: notice.status === "failed",
  };
}

function workflowNoticeEntry(task: WorkflowTaskLifecycle): TranscriptEntry {
  const notice = workflowTaskNoticeData(task);
  return {
    id: `wn_${task.id}`,
    kind: "task_notice",
    text: JSON.stringify(notice),
    isError: notice.status === "failed",
  };
}

function projectsToMainTranscript(task: BackgroundTask): boolean {
  if (!task.isBackgrounded || task.isSidechain === true) return false;
  return task.ownerId === undefined || task.terminalNotification === "main";
}

export function activateStringViewBackgroundCompletions(
  deps: StringViewBackgroundCompletionDeps,
): () => void {
  const listTasks = deps.listBackgroundTasks ?? listBackgroundTasks;
  const subscribeTasks = deps.subscribeBackgroundTasks ?? subscribeBackgroundTasks;
  const subscribeTaskCompletion =
    deps.subscribeBackgroundCompletion ?? subscribeBackgroundCompletion;
  const subscribeWorkflow = deps.subscribeWorkflowCompletion ?? subscribeWorkflowCompletion;
  const readTranscript = deps.getTranscriptEntries ?? getTranscriptEntries;
  const updateTranscript = deps.updateTranscript ?? transcriptActions.update;
  const queue = deps.queue ?? LIVE_QUEUE_BRIDGE;
  const isTurnBusy = deps.isTurnBusy ?? (() => runningRef.current || compactRunningRef.current);
  const projectedNoticeIds = new Set(
    readTranscript()
      .filter((entry) => entry.kind === "task_notice")
      .map((entry) => entry.id),
  );
  // A completion notice belongs to the transcript at the moment the model
  // actually receives it, not when the task ended: an idle session parks it
  // until the queue is drained, so the visible log and the conversation carry
  // the same event at the same point.
  const parked: { entry: TranscriptEntry; replayKey: string }[] = [];

  const updateAndRepaint = (
    updater: (entries: readonly TranscriptEntry[]) => readonly TranscriptEntry[],
  ): void => {
    let changed = false;
    updateTranscript((entries) => {
      const next = updater(entries);
      changed = next !== entries;
      return next;
    });
    if (changed) deps.requestRepaint();
  };

  const stampAgentIdentities = (): void => {
    const tasks = listTasks();
    updateAndRepaint((entries) => applyBackgroundAgentIdentities(tasks, entries));
  };

  const appendOnce = (entry: TranscriptEntry): void => {
    if (projectedNoticeIds.has(entry.id)) return;
    projectedNoticeIds.add(entry.id);
    updateAndRepaint((entries) =>
      entries.some((candidate) => candidate.id === entry.id) ? entries : [...entries, entry],
    );
  };

  const appendOrPark = (entry: TranscriptEntry, replayKey: string): void => {
    if (projectedNoticeIds.has(entry.id)) return;
    if (queue.wasReplayKeyConsumed(replayKey)) {
      appendOnce(entry);
      return;
    }
    if (parked.some((candidate) => candidate.entry.id === entry.id)) return;
    parked.push({ entry, replayKey });
  };

  // Parked notices keep completion order when they land, so the transcript reads
  // in the order the tasks actually finished.
  const flushConsumed = (): void => {
    const ready = parked.filter((candidate) => queue.wasReplayKeyConsumed(candidate.replayKey));
    if (ready.length === 0) return;
    const stillParked = parked.filter(
      (candidate) => !queue.wasReplayKeyConsumed(candidate.replayKey),
    );
    parked.length = 0;
    parked.push(...stillParked);
    for (const candidate of ready) appendOnce(candidate.entry);
  };

  // Waking the model is the same event as showing the notice: only a terminally
  // idle turn with a pending auto-turn resumes, so a live turn keeps ownership
  // and the notification rides its own drain instead of a second one.
  const resumeWhenIdle = (): void => {
    if (isTurnBusy() || !queue.hasPendingAutoTurn()) return;
    deps.requestBackgroundResume?.();
  };

  stampAgentIdentities();
  const unsubscribeTasks = subscribeTasks(stampAgentIdentities);
  const unsubscribeTaskCompletion = subscribeTaskCompletion((task) => {
    stampAgentIdentities();
    if (!projectsToMainTranscript(task)) return;
    appendOrPark(
      backgroundNoticeEntry(task),
      backgroundTaskNoticeIdentity(task.id, task.runGeneration),
    );
    resumeWhenIdle();
  });
  const unsubscribeWorkflow = subscribeWorkflow((task) => {
    if (task.ownerId !== undefined) return;
    appendOrPark(workflowNoticeEntry(task), workflowNoticeReplayKey(task.id));
    resumeWhenIdle();
  });
  const unsubscribeQueue = queue.subscribe(() => {
    flushConsumed();
    resumeWhenIdle();
  });
  const unsubscribeDrain = queue.onDrain(flushConsumed);

  return () => {
    unsubscribeTasks();
    unsubscribeTaskCompletion();
    unsubscribeWorkflow();
    unsubscribeQueue();
    unsubscribeDrain();
  };
}
