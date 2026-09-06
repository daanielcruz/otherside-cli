import {
  type BackgroundTask,
  get as getBackgroundTask,
  holdTaskEviction,
  listRunning as listRunningTasks,
  subscribe as subscribeBackgroundTasks,
} from "@/engine/background/tasks/background.ts";
import type { SessionRecord } from "@/engine/session/record/index.ts";
import {
  loadSubagentTranscript,
  subagentTranscriptSize,
} from "@/engine/session/transcript/subagent-transcript.ts";
import { appStore, dispatch } from "@/store/app-store/index.ts";
import type {
  ScrollbackBatch,
  StringComponent,
  StringViewContext,
} from "@/terminal-runtime/string-view/component.js";
import { renderSettledEntries } from "@/ui/transcript/entry-lines.ts";
import type { TranscriptPresentation } from "@/ui/transcript/presentation.ts";
import { SettledScrollbackArchive } from "@/ui/transcript/scrollback-archive.ts";
import { settledEntriesOf } from "@/ui/transcript/settled-boundary.ts";
import type { SettledEntry } from "@/ui/transcript/settled-entry.ts";
import {
  type AgentTranscriptView,
  EMPTY_AGENT_TRANSCRIPT,
  projectAgentTranscript,
} from "@/ui/transcript/stream/agent-transcript-projection.ts";
import { mapTranscriptEntries } from "@/ui/transcript/string-view-store.ts";

/** How often a running agent's document re-reads its own transcript file. */
export const AGENT_DOCUMENT_POLL_MS = 400;

/**
 * The document of the agent the panel selection opened. It reads that agent's own
 * transcript file rather than the main conversation, so the two never mix, and it
 * holds the task against eviction for as long as it is on screen.
 */
export class StringViewAgentDocument implements StringComponent {
  private context: StringViewContext | undefined;
  private readonly unsubs: (() => void)[] = [];
  private releaseEviction: (() => void) | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private taskId: string | null = null;
  private view: AgentTranscriptView = EMPTY_AGENT_TRANSCRIPT;
  private records: SessionRecord[] = [];
  private loadedSize = -1;
  private childCallIdsKey = "";
  private refreshing = false;
  private rerunQueued = false;
  private verbose = false;
  private entries: readonly SettledEntry[] = [];
  private readonly archive = new SettledScrollbackArchive();

  mount(ctx: StringViewContext): void {
    this.unmount();
    this.context = ctx;
    this.unsubs.push(
      appStore.subscribe(() => this.syncFromStore()),
      subscribeBackgroundTasks(() => {
        // A task that finished while it was open keeps its document; one that was
        // evicted altogether has nothing left to show.
        if (this.taskId !== null && getBackgroundTask(this.taskId) === undefined) {
          dispatch({ type: "view/setViewingAgent", id: null });
          return;
        }
        void this.refresh();
      }),
    );
    this.syncFromStore();
  }

  unmount(): void {
    for (const unsub of this.unsubs.splice(0)) unsub();
    this.closeDocument();
    this.context = undefined;
  }

  isActive(): boolean {
    return this.taskId !== null;
  }

  /**
   * The live frame carries only what has not settled: the archived history lives
   * in native scrollback, so a keystroke's repaint costs the in-flight tail, not
   * the whole sub-agent transcript.
   */
  render(width: number): string[] {
    if (this.taskId === null) return [];
    const settledCount = this.archive.settledEntries().length;
    return renderSettledEntries(width, this.entries.slice(settledCount), this.presentation());
  }

  takeScrollbackBatch(width: number): ScrollbackBatch {
    return this.archive.takeBatch(width, this.presentation());
  }

  snapshotScrollback(width: number): readonly string[] {
    return this.archive.snapshot(width, this.presentation());
  }

  private presentation(): TranscriptPresentation {
    return this.verbose ? "verbose" : "compact";
  }

  private setEntries(entries: readonly SettledEntry[]): void {
    this.entries = entries;
    this.archive.setSettled(settledEntriesOf(entries));
  }

  private syncFromStore(): void {
    const state = appStore.getState();
    if (state.view.verboseTranscript !== this.verbose) {
      this.verbose = state.view.verboseTranscript;
      this.archive.invalidate();
      if (this.taskId !== null) this.context?.requestRender();
    }
    const next = state.view.viewingAgentId;
    if (next === this.taskId) return;
    this.closeDocument();
    this.taskId = next;
    if (next === null) {
      this.context?.requestRender();
      return;
    }
    this.releaseEviction = holdTaskEviction(next);
    void this.refresh();
    this.syncPollTimer();
    this.context?.requestRender();
  }

  private closeDocument(): void {
    this.clearPollTimer();
    this.releaseEviction?.();
    this.releaseEviction = undefined;
    this.taskId = null;
    this.view = EMPTY_AGENT_TRANSCRIPT;
    this.records = [];
    this.loadedSize = -1;
    this.childCallIdsKey = "";
    this.entries = [];
    this.archive.reset();
  }

  private task(): BackgroundTask | undefined {
    return this.taskId === null ? undefined : getBackgroundTask(this.taskId);
  }

  private runningChildCallIds(): Set<string> {
    const callIds = new Set<string>();
    if (this.taskId === null) return callIds;
    for (const candidate of listRunningTasks()) {
      if (candidate.parentTaskId === this.taskId) callIds.add(candidate.parentToolCallId);
    }
    return callIds;
  }

  /**
   * One read at a time, with a trailing re-run for triggers that arrived meanwhile:
   * two interleaved loads can publish out of order and freeze the view on an old
   * prefix, because the stale one overwrites records the fresh one already counted.
   */
  private async refresh(): Promise<void> {
    if (this.refreshing) {
      this.rerunQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.rerunQueued = false;
        await this.refreshOnce();
      } while (this.rerunQueued && this.taskId !== null);
    } finally {
      this.refreshing = false;
    }
  }

  private async refreshOnce(): Promise<void> {
    const task = this.task();
    // An agent records its own transcript, and its task says where: the session it
    // was spawned from, that session's directory, and its own fork.
    if (task?.cwd === undefined || task.sessionId === undefined || task.forkId === undefined) {
      return;
    }
    const ref = { cwd: task.cwd, sessionId: task.sessionId, forkId: task.forkId };
    const isRunning = task.status === "running";
    const size = await subagentTranscriptSize(ref);
    if (this.taskId === null) return;

    const childCallIds = this.runningChildCallIds();
    const childrenKey = [...childCallIds].sort().join(",");
    const childrenChanged = childrenKey !== this.childCallIdsKey;
    const awaitingTool = isRunning && this.view.llmActive === false;
    if (size === this.loadedSize && !childrenChanged && !awaitingTool) return;
    this.childCallIdsKey = childrenKey;

    if (size !== this.loadedSize) {
      const records = await loadSubagentTranscript(ref);
      if (this.taskId === null) return;
      this.records = records;
      // Counted as read only after the load lands, so a load that raced or threw
      // leaves the size unseen and the next tick retries it.
      this.loadedSize = size;
    }
    this.view = projectAgentTranscript(this.records, isRunning, childCallIds);
    this.setEntries(mapTranscriptEntries(this.view.entries));
    this.syncPollTimer();
    this.context?.requestRender();
  }

  private syncPollTimer(): void {
    const shouldPoll = this.taskId !== null && this.task()?.status === "running";
    if (shouldPoll === (this.pollTimer !== undefined)) return;
    if (!shouldPoll) {
      this.clearPollTimer();
      return;
    }
    this.pollTimer = setInterval(() => void this.refresh(), AGENT_DOCUMENT_POLL_MS);
    this.pollTimer.unref?.();
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }
}
