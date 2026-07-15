import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef } from "react";
import {
  type BackgroundTask,
  list as listBackgroundTasks,
  subscribe as subscribeBackgroundTasks,
  taskFinalStatus,
} from "@/engine/background/tasks/background.ts";
import {
  listWorkflowTasks,
  subscribeWorkflowTasks,
} from "@/engine/background/workflows/runtime/store/store.ts";
import type { LocalWorkflowTaskState } from "@/engine/background/workflows/runtime/store/types.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import { applyAgentIdentityToTranscript } from "@/engine/session/record/transcript-update.ts";
import type { AutoClearDispatch } from "@/kernel/std/state/auto-clear-dispatch.ts";
import { elapsedMs } from "@/ui/transcript/stats.ts";
import type { TranscriptEntry } from "@/ui/transcript/types";

function notificationTag(text: string, tag: string): string | undefined {
  return text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim();
}

function notificationStatus(text: string): "completed" | "failed" | "killed" {
  const status = notificationTag(text, "status");
  if (status === "failed" || status === "error") return "failed";
  if (status === "killed") return "killed";
  return "completed";
}

export function taskKindForNotificationSummary(summary: string): "shell" | "agent" {
  return summary.startsWith("Background command") ? "shell" : "agent";
}

export function completionNoticeDisposition(replayKey: string): "append" | "park" {
  return emitQueue.wasReplayKeyConsumed(replayKey) ? "append" : "park";
}

export function backgroundTaskNoticeIdentity(taskId: string, runGeneration: number): string {
  return `bg:${taskId}:${runGeneration}`;
}

export function recordBackgroundTaskTransition(
  transitionedTasks: Set<string>,
  replayKey: string,
): boolean {
  if (transitionedTasks.has(replayKey)) return false;
  transitionedTasks.add(replayKey);
  return true;
}

function backgroundTaskIdForReplayKey(replayKey: string): string {
  const value = replayKey.slice(3);
  const generationSeparator = value.lastIndexOf(":");
  return generationSeparator < 0 ? value : value.slice(0, generationSeparator);
}

export interface AsyncCompletionResumeDeps {
  getBgTasksOpen: () => boolean;
  runningRef: { current: boolean };
  requestBackgroundResumeRef: { current: () => void };
  transitionedTasksRef: { current: Set<string> };
  transitionedWorkflowTasksRef: { current: Set<string> };
  compactRunningRef: { current: boolean };
  setBgTasks: Dispatch<SetStateAction<BackgroundTask[]>>;
  setBgTasksOpen: Dispatch<SetStateAction<boolean>>;
  setWorkflowTasks: Dispatch<SetStateAction<LocalWorkflowTaskState[]>>;
  setTranscript: (value: SetStateAction<readonly TranscriptEntry[]>) => void;
  flushParkedDispatch: AutoClearDispatch;
}

export function useAsyncCompletionResume(deps: AsyncCompletionResumeDeps): void {
  const {
    getBgTasksOpen,
    runningRef,
    requestBackgroundResumeRef,
    transitionedTasksRef,
    transitionedWorkflowTasksRef,
    compactRunningRef,
    setBgTasks,
    setBgTasksOpen,
    setWorkflowTasks,
    setTranscript,
    flushParkedDispatch,
  } = deps;

  // Completion notices render at CONSUMPTION time, not completion time. The
  // consumed-key receipt handles both callback orderings: a notice may arrive
  // before its item is queued (workflows) or after its item was drained (the
  // throttled background-task store).
  const parkedNoticesRef = useRef<Array<{ entry: TranscriptEntry; replayKey: string }>>([]);
  const flushConsumedNotices = useCallback((): void => {
    if (parkedNoticesRef.current.length === 0) return;
    const ready = parkedNoticesRef.current.filter((p) =>
      emitQueue.wasReplayKeyConsumed(p.replayKey),
    );
    if (ready.length === 0) return;
    parkedNoticesRef.current = parkedNoticesRef.current.filter(
      (p) => !emitQueue.wasReplayKeyConsumed(p.replayKey),
    );
    setTranscript((t) => {
      const add = ready.map((p) => p.entry).filter((e) => !t.some((x) => x.id === e.id));
      return add.length > 0 ? [...t, ...add] : t;
    });
  }, [setTranscript]);
  const appendOrParkNotice = useCallback(
    (entry: TranscriptEntry, replayKey: string): void => {
      if (completionNoticeDisposition(replayKey) === "park") {
        if (!parkedNoticesRef.current.some((p) => p.entry.id === entry.id)) {
          parkedNoticesRef.current.push({ entry, replayKey });
        }
        return;
      }
      setTranscript((t) => (t.some((e) => e.id === entry.id) ? t : [...t, entry]));
    },
    [setTranscript],
  );
  useEffect(() => emitQueue.onDrain(() => flushConsumedNotices()), [flushConsumedNotices]);
  const completionTargetsMain = useCallback((replayKey: string): boolean => {
    return emitQueue
      .peek()
      .some(
        (item) =>
          item.replayKey === replayKey && item.target !== "inventory" && item.target !== "none",
      );
  }, []);
  const appendBackgroundTaskNotice = useCallback(
    (task: BackgroundTask): void => {
      const isShell = task.kind === "shell";
      const notice: Record<string, unknown> = {
        taskKind: isShell ? "shell" : "agent",
        status: taskFinalStatus(task.status),
        description: task.description ?? task.agentName,
        durationMs: task.endedAt ? task.endedAt - task.startedAt : 0,
        taskId: task.id,
      };
      if (isShell && task.exitCode !== undefined) notice.exitCode = task.exitCode;
      const replayKey = backgroundTaskNoticeIdentity(task.id, task.runGeneration);
      appendOrParkNotice(
        {
          id: `n_${replayKey}`,
          kind: "task_notice",
          text: JSON.stringify(notice),
          isError: task.status === "error",
        },
        replayKey,
      );
    },
    [appendOrParkNotice],
  );
  const appendWorkflowNotice = useCallback(
    (task: LocalWorkflowTaskState): void => {
      const status = taskFinalStatus(task.status);
      appendOrParkNotice(
        {
          id: `wn_${task.id}`,
          kind: "task_notice",
          text: JSON.stringify({
            taskKind: "workflow",
            status,
            description: task.title ?? task.description ?? task.workflowName,
            durationMs: elapsedMs(task.startedAt, task.endedAt),
            taskId: task.id,
          }),
          isError: status === "failed",
        },
        `wf:${task.id}`,
      );
    },
    [appendOrParkNotice],
  );
  const appendReroutedOwnerNotices = useCallback((): void => {
    const backgroundTasks = new Map(listBackgroundTasks().map((task) => [task.id, task]));
    const workflowTasks = new Map(listWorkflowTasks().map((task) => [task.id, task]));
    for (const item of emitQueue.peek()) {
      if (item.ownerId === undefined || item.target !== "both") continue;
      if (item.payload.kind !== "task_notification_xml" || item.replayKey === undefined) continue;
      if (item.replayKey.startsWith("bg:")) {
        const taskId = backgroundTaskIdForReplayKey(item.replayKey);
        if (!recordBackgroundTaskTransition(transitionedTasksRef.current, item.replayKey)) continue;
        const task = backgroundTasks.get(taskId);
        if (task !== undefined) {
          appendBackgroundTaskNotice(task);
          continue;
        }
        const status = notificationStatus(item.payload.text);
        const summary = item.payload.summary ?? "Background agent";
        appendOrParkNotice(
          {
            id: `n_${item.replayKey}`,
            kind: "task_notice",
            text: JSON.stringify({
              taskKind: taskKindForNotificationSummary(summary),
              status,
              description: summary,
              durationMs: 0,
              taskId,
            }),
            isError: status === "failed",
          },
          item.replayKey,
        );
        continue;
      }
      if (!item.replayKey.startsWith("wf:")) continue;
      const taskId = item.replayKey.slice(3);
      if (transitionedWorkflowTasksRef.current.has(taskId)) continue;
      transitionedWorkflowTasksRef.current.add(taskId);
      const task = workflowTasks.get(taskId);
      if (task !== undefined) {
        appendWorkflowNotice(task);
        continue;
      }
      const status = notificationStatus(item.payload.text);
      appendOrParkNotice(
        {
          id: `wn_${taskId}`,
          kind: "task_notice",
          text: JSON.stringify({
            taskKind: "workflow",
            status,
            description: item.payload.summary ?? "Background workflow",
            durationMs: 0,
            taskId,
          }),
          isError: status === "failed",
        },
        item.replayKey,
      );
    }
  }, [appendBackgroundTaskNotice, appendOrParkNotice, appendWorkflowNotice]);
  useEffect(() => {
    const unsub = subscribeBackgroundTasks(() => {
      const tasks = listBackgroundTasks();
      setBgTasks(tasks);
      const agentIdentities = new Map<string, { model: string; name?: string }>();
      for (const task of tasks) {
        if (task.kind === "agent" && task.isBackgrounded && task.model) {
          agentIdentities.set(task.parentToolCallId, {
            model: task.model,
            ...(task.agentName ? { name: task.agentName } : {}),
          });
        }
      }
      if (agentIdentities.size > 0) {
        setTranscript((t) => {
          let next = t;
          for (const [callId, identity] of agentIdentities) {
            next = applyAgentIdentityToTranscript(next, callId, identity);
          }
          return next;
        });
      }
      let anyTransition = false;
      for (const task of tasks) {
        if (!task.isBackgrounded) continue;
        if (task.status === "running") continue;
        if (task.isSidechain) continue;
        const replayKey = backgroundTaskNoticeIdentity(task.id, task.runGeneration);
        if (task.ownerId !== undefined && !completionTargetsMain(replayKey)) continue;
        if (!recordBackgroundTaskTransition(transitionedTasksRef.current, replayKey)) continue;
        anyTransition = true;
        appendBackgroundTaskNotice(task);
      }
      const liveTaskIds = new Set(tasks.map((task) => task.id));
      for (const replayKey of [...transitionedTasksRef.current]) {
        if (!liveTaskIds.has(backgroundTaskIdForReplayKey(replayKey))) {
          transitionedTasksRef.current.delete(replayKey);
        }
      }
      const hasRunningBackgroundTask = tasks.some(
        (task) => task.isBackgrounded && task.status === "running",
      );
      if (anyTransition && getBgTasksOpen() && !hasRunningBackgroundTask) {
        setBgTasksOpen(false);
      }
    });
    return unsub;
  }, [setTranscript, appendBackgroundTaskNotice, completionTargetsMain]);
  useEffect(() => {
    return subscribeWorkflowTasks(() => {
      const tasks = listWorkflowTasks();
      setWorkflowTasks(tasks);
      for (const task of tasks) {
        if (task.status === "running" || task.status === "paused") continue;
        if (transitionedWorkflowTasksRef.current.has(task.id)) continue;
        const replayKey = `wf:${task.id}`;
        if (task.ownerId !== undefined && !completionTargetsMain(replayKey)) continue;
        transitionedWorkflowTasksRef.current.add(task.id);
        appendWorkflowNotice(task);
      }
      const liveWorkflowIds = new Set(tasks.map((task) => task.id));
      for (const id of [...transitionedWorkflowTasksRef.current]) {
        if (!liveWorkflowIds.has(id)) transitionedWorkflowTasksRef.current.delete(id);
      }
    });
  }, [setTranscript, appendWorkflowNotice, completionTargetsMain]);
  useEffect(() => {
    const canFlushParked = (): boolean =>
      !runningRef.current && !compactRunningRef.current && emitQueue.hasPendingAutoTurn();
    const flushParkedNotifications = (): void => {
      appendReroutedOwnerNotices();
      flushConsumedNotices();
      if (!canFlushParked()) return;
      flushParkedDispatch.arm({
        onTimeout: () => {
          if (!canFlushParked()) return;
          requestBackgroundResumeRef.current();
        },
      });
    };
    return emitQueue.subscribe(flushParkedNotifications);
  }, [flushParkedDispatch, flushConsumedNotices, appendReroutedOwnerNotices]);
}
