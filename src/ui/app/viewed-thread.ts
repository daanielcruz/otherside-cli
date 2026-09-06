import { pendingAgentSteers } from "@/engine/background/subagents/fork/steering.ts";
import {
  type BackgroundTask,
  get as getBackgroundTask,
  list as listBackgroundTasks,
} from "@/engine/background/tasks/background.ts";
import { list as listTasks, type TaskRecord } from "@/engine/background/tasks/index.ts";
import { aggregateSubtreeProgress } from "@/engine/background/tasks/progress.ts";
import { defaultEffortForModel } from "@/engine/model/catalog.ts";
import type { ContextUsageSnapshot } from "@/engine/session/usage/snapshot.ts";
import type { ProviderModelRoute } from "@/kernel/std/types/provider-ids.ts";
import type { BrokerState } from "@/store/app-store/broker.ts";
import { appStore } from "@/store/app-store/index.ts";
import { readLiveOutputTokens } from "@/store/live-tokens/index.ts";
import { type QueuedMessage, queueStore } from "@/store/queue-store/index.ts";
import { generatorActiveRef, turnStartedAtRef } from "@/store/turn-run/index.ts";
import { readStringViewBrokerState } from "@/ui/chrome/status/string-view-state.ts";

const EMPTY_QUEUE: readonly QueuedMessage[] = [];
const EMPTY_TASKS: readonly TaskRecord[] = [];

/**
 * Whose work the chrome below the document is describing. The footer sits under
 * whatever document is on screen, so it answers for that surface: with an agent's
 * document open, every readout under it belongs to that agent rather than to the
 * leader that spawned it.
 */
export interface ViewedThread {
  /** The agent whose document is open, or null while the leader's is. */
  readonly agent: BackgroundTask | null;
  /** The route and mode the status line states. */
  readonly broker: BrokerState;
  /** Whether the viewed thread is working, which is what draws the progress block. */
  readonly busy: boolean;
  /** When that work began, or null when nothing is running. */
  readonly startedAt: number | null;
  /** The verb the progress block leads with, or null to let the leader choose one. */
  readonly verb: string | null;
  /** Tokens produced so far by the viewed thread. */
  readonly outputTokens: number;
  /** The context readout on the status line. */
  readonly context: ContextUsageSnapshot;
  readonly queued: readonly QueuedMessage[];
  readonly tasks: readonly TaskRecord[];
}

function routeOf(task: BackgroundTask, fallback: BrokerState): ProviderModelRoute {
  return task.provider !== undefined && task.model !== undefined
    ? { provider: task.provider, model: task.model }
    : { provider: fallback.provider, model: fallback.model };
}

/**
 * An agent answers for its own route and effort but keeps the leader's permission
 * and orchestration modes: those govern the session, not the thread inside it.
 */
function brokerFor(task: BackgroundTask, leader: BrokerState): BrokerState {
  const route = routeOf(task, leader);
  return {
    ...leader,
    ...route,
    effort: task.effort ?? defaultEffortForModel(route),
    ultracode: false,
  };
}

function contextFor(task: BackgroundTask): ContextUsageSnapshot {
  // An agent reports what it spent, and nothing about the leader's cache.
  return {
    inputTokens: task.inputTokens,
    outputTokens: task.outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

/** Whether a thread is mid-turn: the leader by its generator, an agent by its run. */
function busyFor(task: BackgroundTask | null): boolean {
  if (task === null) return generatorActiveRef.current;
  // A parked fork (turn ended, live owned work) is alive but not mid-turn:
  // no spinner, no live elapsed — a steer or child notification wakes it.
  return task.status === "running" && task.parkedAt === undefined;
}

function leaderThread(broker: BrokerState): ViewedThread {
  const view = appStore.getState().view;
  return {
    agent: null,
    broker,
    busy: busyFor(null),
    startedAt: view.progressStartedAt ?? turnStartedAtRef.current,
    verb: null,
    outputTokens: readLiveOutputTokens(),
    context: appStore.getState().usage.mainLastContext,
    queued: queueStore.getState().messages,
    tasks: listTasks(),
  };
}

function agentThread(task: BackgroundTask, leader: BrokerState): ViewedThread {
  const running = busyFor(task);
  return {
    agent: task,
    broker: brokerFor(task, leader),
    busy: running,
    startedAt: running ? task.startedAt : null,
    verb: "Running",
    outputTokens: aggregateSubtreeProgress(task.id, listBackgroundTasks()).tokenCount,
    context: contextFor(task),
    // Text typed over a live agent's document steers that agent; its queue is
    // the pending steers, shown until the fork's own turn drains them. The
    // leader's queued messages never leak into this view.
    queued: task.forkId === undefined ? EMPTY_QUEUE : steerPreview(task.forkId),
    // An agent's planning tasks live under its own fork, never the leader's list.
    tasks: task.forkId === undefined ? EMPTY_TASKS : listTasks(task.forkId),
  };
}

function steerPreview(forkId: string): readonly QueuedMessage[] {
  return pendingAgentSteers(forkId).map((steer, index) => ({
    id: steer.queueId ?? `steer-${index}`,
    text: steer.text,
    expanded: steer.text,
  }));
}

/** Reads whichever thread the open document belongs to. */
export function viewedThread(): ViewedThread {
  const leader = readStringViewBrokerState();
  const id = appStore.getState().view.viewingAgentId;
  if (id === null) return leaderThread(leader);
  const task = getBackgroundTask(id);
  return task === undefined ? leaderThread(leader) : agentThread(task, leader);
}

/** The id of the open agent's document, for surfaces that only need to branch. */
export function viewedAgentId(): string | null {
  return appStore.getState().view.viewingAgentId;
}

/**
 * Whether the viewed thread is mid-turn, cheap enough for a frame clock: two
 * store reads instead of the full thread snapshot `viewedThread()` assembles.
 */
export function viewedThreadBusy(): boolean {
  const id = appStore.getState().view.viewingAgentId;
  if (id === null) return busyFor(null);
  return busyFor(getBackgroundTask(id) ?? null);
}
