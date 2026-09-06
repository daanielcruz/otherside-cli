import { notifySubscribers as notifyTaskSubscribers } from "@/engine/background/tasks/index.ts";
import {
  getActiveSessionId,
  setTaskOutputSession,
} from "@/engine/background/tasks/output-files.ts";
import type { Agent } from "@/engine/queue/index.ts";
import { restoreGoalFromRecords } from "@/engine/queue/state.ts";
import { estimateHarnessTokens } from "@/engine/session/compact/harness-baseline.ts";
import { setEstimatedUsage, setLastUsage } from "@/engine/session/compact/last-usage.ts";
import {
  hydratePreservedImages,
  type PreservedImageLedger,
} from "@/engine/session/compact/preserved-image-ledger.ts";
import { estimateConversationTokens } from "@/engine/session/compact/token-count.ts";
import { cleanupSessionHeapState } from "@/engine/session/finalize.ts";
import {
  latestContextUsageSnapshotFromSessionRecords,
  loadSessionForResume,
  resolveSessionBrokerState,
  type Session,
  type SessionBrokerState,
  type SessionRecord,
  seedResumedSessionTitle,
  sessionBrokerStateKey,
  type UsageRecord,
} from "@/engine/session/index.ts";
import { isCompactionBoundary } from "@/engine/session/record/index.ts";
import type { ToolOutputArchiveSessionRecord } from "@/engine/session/record/schema.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import {
  loadSystemInjectionsForSession,
  type SystemInjectionEntry,
  systemInjectionsAfterCompact,
} from "@/engine/session/system-injection-store.ts";
import { quoteTitleForResume } from "@/engine/session/title/resolve.ts";
import { sessionRecordsToMessages } from "@/engine/session/transcript/to-messages.ts";
import type { TokenTotals, UsageByProvider } from "@/engine/session/usage/provider.ts";
import type { ContextUsageSnapshot } from "@/engine/session/usage/snapshot.ts";
import {
  mainTokenTotalsFromRecords,
  usageByProviderFromRecords,
} from "@/engine/session/usage/store.ts";
import {
  attachSessionWorktreeHost,
  detachSessionWorktreeHost,
  readProjectWorktreeSlot,
  restoreSessionWorktreeOnResume,
  stampedWorktreeStateFrom,
} from "@/engine/session/worktree.ts";
import { restoreToolOutputArchive } from "@/engine/tool-output-archive/index.ts";
import { sanitizeMessages } from "@/engine/translator/index.ts";
import { fastModeForProvider, type UserConfig } from "@/kernel/config/config.ts";
import { setActivePasteStore } from "@/kernel/std/paste/registry.ts";
import { setTrackedCwd } from "@/kernel/std/state/cwd-state.ts";
import type { PasteStore } from "@/kernel/std/types/paste.ts";
import type { BrokerHandle } from "@/kernel/std/types/request.ts";
import type { MutableRef } from "@/kernel/std/types/state.ts";
import { dim } from "@/terminal-runtime";

export interface SessionTitleSink {
  setTitle(title: string | null): void;
  setAttempted(attempted: boolean): void;
  reset(): void;
}

export interface ResumeSessionDeps {
  session: Session;
  broker: BrokerHandle;
  agent: Agent;
  sessionTitle: SessionTitleSink;
  createPasteStore: (sessionId: string) => PasteStore;
  recordsToTranscript: (records: SessionRecord[]) => TranscriptEntry[];
  getRuntimeConfig: () => UserConfig;
  setTranscript: (
    value:
      | readonly TranscriptEntry[]
      | ((prev: readonly TranscriptEntry[]) => readonly TranscriptEntry[]),
  ) => void;
  setMainLastContext: (snapshot: ContextUsageSnapshot) => void;
  setUsageByProvider: (usage: UsageByProvider) => void;
  setMainTokenTotals: (totals: TokenTotals) => void;
  pasteStoreRef: MutableRef<PasteStore>;
  suppressBrokerPersistenceRef: MutableRef<boolean>;
  persistedSessionBrokerStateRef: MutableRef<string>;
  nextTranscriptId: (prefix: string) => string;
  transcriptBatch: { flushNow: () => void };
  runSessionFinalizers: () => void;
  resetRenderSurface: () => void;
}

export type ResumeSessionFn = (id: string) => Promise<void>;

export function createResumeSession(deps: ResumeSessionDeps): ResumeSessionFn {
  const {
    session,
    broker,
    agent,
    sessionTitle,
    createPasteStore,
    recordsToTranscript,
    getRuntimeConfig,
    setTranscript,
    setMainLastContext,
    setUsageByProvider,
    setMainTokenTotals,
    pasteStoreRef,
    suppressBrokerPersistenceRef,
    persistedSessionBrokerStateRef,
    nextTranscriptId,
    transcriptBatch,
    runSessionFinalizers,
    resetRenderSurface,
  } = deps;

  return async function resumeSession(id: string): Promise<void> {
    const {
      records,
      modelRecords,
      usageRecords,
      chainHead,
      cwd,
      tailRecords,
      preservedImageLedger,
    } = await loadSessionForResume(id);
    const resumedCwd = cwd ?? session.storageCwd;
    const systemInjections = loadSystemInjectionsForSession(id, resumedCwd);
    if (records.length === 0) {
      setTranscript((t) => [
        ...t,
        {
          id: nextTranscriptId("sys"),
          kind: "system",
          text: `session ${id} is empty`,
        },
      ]);
      return;
    }
    // Large resumes materialize typed transcript entries only for the loaded tail.
    const entries = recordsToTranscript(tailRecords);
    // Restore the latest unmet durable goal marker before the resumed session
    // becomes visible so its stop gate and status badge are active immediately.
    restoreGoalFromRecords(id, records);
    const restoredUsage = usageByProviderFromRecords([...records, ...usageRecords]);
    const restoredBrokerState = resolveSessionBrokerState(records, broker.read());
    const restoredContextUsage = latestContextUsageSnapshotFromSessionRecords(
      records,
      {
        provider: restoredBrokerState.provider,
        model: restoredBrokerState.model,
      },
      usageRecords,
    );
    // Shared messages derivation for context baseline + hydrate (single sanitize).
    const resumedMessages = sanitizeMessages(sessionRecordsToMessages(modelRecords));
    applyResumedContextUsage({
      restoredContextUsage,
      target: restoredBrokerState,
      // Baseline the resumed context on the COMPACTED message set (what actually
      // goes to the model), not the full display transcript — which keeps the
      // pre-compaction history the record still holds. Resuming a just-compacted
      // session otherwise reads ~full context ("0% available"). Matches the fresh
      // startup path (`estimateConversationTokens(session.messages)`).
      messagesBaseline: estimateConversationTokens(resumedMessages),
      setMainLastContext,
    });
    const previousSessionId = session.id;
    cleanupSessionHeapState(session.id, session.storageCwd);
    runSessionFinalizers();
    detachSessionWorktreeHost(previousSessionId);
    hydrateSessionFromRecords({
      session,
      id,
      records,
      modelRecords,
      usageRecords,
      chainHead,
      systemInjections,
      pasteStoreRef,
      createPasteStore,
      messages: resumedMessages,
      preservedImageLedger,
    });
    session.storageCwd = resumedCwd;
    session.worktree = null;
    session.cwd = resumedCwd;
    setTrackedCwd(resumedCwd);
    attachSessionWorktreeHost(session);
    // The transcript stamp is the restore source of truth; the project slot
    // only covers transcripts that predate stamps.
    const stamped = stampedWorktreeStateFrom(records);
    const recordedWorktree = stamped.stamped ? stamped.state : readProjectWorktreeSlot(id);
    const worktreeRestore = await restoreSessionWorktreeOnResume(session, recordedWorktree);
    setTrackedCwd(session.cwd);
    setTaskOutputSession({ sessionId: id, cwd: session.cwd });
    // The always-mounted task panel re-hydrates lazily on read; without a wake
    // after the rebind it keeps rendering the previous session's list and the
    // resumed session's persisted tasks never surface.
    notifyTaskSubscribers();
    restoreBrokerStateOnResume({
      broker,
      target: restoredBrokerState,
      runtimeConfig: getRuntimeConfig(),
      suppressRef: suppressBrokerPersistenceRef,
      persistedRef: persistedSessionBrokerStateRef,
    });
    seedResumedSessionTitle(sessionTitle, id, () => session.id === id);
    session.append("resume", { id, records: records.length });
    agent.resetSessionScopedPermissions();
    replayInjectionsFromRecords(session.records, agent, session.systemInjections);
    resetRenderSurface();
    const resumeEntries =
      worktreeRestore.warning !== undefined
        ? [
            ...entries,
            {
              id: nextTranscriptId("sys"),
              kind: "system" as const,
              text: worktreeRestore.warning,
            },
          ]
        : entries;
    setTranscript(resumeEntries);
    transcriptBatch.flushNow();
    setUsageByProvider(restoredUsage);
    setMainTokenTotals(mainTokenTotalsFromRecords([...records, ...usageRecords]));
  };
}

function applyResumedContextUsage(args: {
  restoredContextUsage: ContextUsageSnapshot | null;
  target: SessionBrokerState;
  messagesBaseline: number;
  setMainLastContext: (snapshot: ContextUsageSnapshot) => void;
}): void {
  const { restoredContextUsage, target, messagesBaseline, setMainLastContext } = args;
  if (restoredContextUsage) {
    setMainLastContext({
      inputTokens: restoredContextUsage.inputTokens,
      outputTokens: restoredContextUsage.outputTokens,
      cacheReadInputTokens: restoredContextUsage.cacheReadInputTokens,
      cacheCreationInputTokens: restoredContextUsage.cacheCreationInputTokens,
    });
    setLastUsage(restoredContextUsage);
    return;
  }
  const resumeBaseline = messagesBaseline + estimateHarnessTokens(target.provider, target.model);
  setMainLastContext({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: resumeBaseline,
    cacheCreationInputTokens: 0,
  });
  setEstimatedUsage({
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: resumeBaseline,
  });
}

function restoreBrokerStateOnResume(args: {
  broker: BrokerHandle;
  target: SessionBrokerState;
  runtimeConfig: UserConfig;
  suppressRef: MutableRef<boolean>;
  persistedRef: MutableRef<string>;
}): void {
  const { broker, target, runtimeConfig, suppressRef, persistedRef } = args;
  suppressRef.current = true;
  try {
    if (broker.read().provider !== target.provider) {
      broker.dispatch({
        kind: "set_route",
        route: { provider: target.provider, model: target.model },
        fastMode: target.fastMode ?? fastModeForProvider(runtimeConfig, target.provider),
      });
    } else if (broker.read().model !== target.model) {
      broker.dispatch({
        kind: "set_route",
        route: { provider: target.provider, model: target.model },
        fastMode: target.fastMode ?? fastModeForProvider(runtimeConfig, target.provider),
      });
    }
    if (broker.read().effort !== target.effort) {
      broker.dispatch({ kind: "set_effort", effort: target.effort });
    }
    const restoredFastMode = target.fastMode ?? fastModeForProvider(runtimeConfig, target.provider);
    if (broker.read().fastMode !== restoredFastMode) {
      broker.dispatch({ kind: "set_fast_mode", enabled: restoredFastMode });
    }
    if (target.permissionMode && broker.read().permissionMode !== target.permissionMode) {
      broker.dispatch({ kind: "set_permission_mode", mode: target.permissionMode });
    }
    // Ultracode is session-scoped, restored like effort: the resumed session's own
    // recorded state wins; a pre-persistence session (no recorded ultracode) falls
    // back to the runtime config default. Enabling re-applies the persisted effort.
    // Disabling clears a possibly-leaked ultracode from the PRE-resume broker via
    // `set_effort` (which clears ultracode + re-applies the same effort) — plain
    // `set_ultracode:false` would reset effort to the model default.
    const desiredUltracode =
      target.ultracode !== undefined ? target.ultracode : !!runtimeConfig.ultracode;
    if (desiredUltracode) {
      broker.dispatch({
        kind: "set_ultracode",
        enabled: true,
        effort:
          target.ultracode !== undefined
            ? (target.effort ?? "high")
            : (runtimeConfig.ultracodeEffort ?? "high"),
      });
    } else if (broker.read().ultracode) {
      broker.dispatch({ kind: "set_effort", effort: target.effort });
    }
  } finally {
    suppressRef.current = false;
    persistedRef.current = sessionBrokerStateKey(broker.read());
  }
}

export function hydrateSessionFromRecords(args: {
  session: Session;
  id: string;
  records: SessionRecord[];
  modelRecords?: SessionRecord[];
  usageRecords: UsageRecord[];
  chainHead: string | null;
  systemInjections?: SystemInjectionEntry[];
  pasteStoreRef: MutableRef<PasteStore>;
  createPasteStore: (sessionId: string) => PasteStore;
  /** Precomputed model messages; when omitted, derived from modelRecords once. */
  messages?: ReturnType<typeof sanitizeMessages>;
  /** Ledger from the load pass; when omitted, the records are hydrated here. */
  preservedImageLedger?: PreservedImageLedger | undefined;
}): void {
  const {
    session,
    id,
    records,
    modelRecords = records,
    usageRecords,
    chainHead,
    systemInjections = loadSystemInjectionsForSession(id, session.storageCwd),
    pasteStoreRef,
    createPasteStore,
    messages,
    preservedImageLedger,
  } = args;
  session.id = id;
  session.preservedImageLedger =
    preservedImageLedger ?? hydratePreservedImages([records, modelRecords]);
  pasteStoreRef.current = createPasteStore(session.id);
  // Keep the prompt's paste placeholders backed by the resumed session's store.
  setActivePasteStore(pasteStoreRef.current);
  if (chainHead) session.chain.seed(chainHead);
  else session.chain.headUuid = null;
  session.records.splice(0, session.records.length, ...records);
  session.usageRecords.splice(0, session.usageRecords.length, ...usageRecords);
  session.systemInjections.splice(0, session.systemInjections.length, ...systemInjections);
  session.hookEvents.splice(0, session.hookEvents.length);
  const hydratedMessages = messages ?? sanitizeMessages(sessionRecordsToMessages(modelRecords));
  session.messages.splice(0, session.messages.length, ...hydratedMessages);
  const archiveRecords = records
    .filter(
      (record): record is ToolOutputArchiveSessionRecord => record.type === "content_replacement",
    )
    .map((record) => ({
      kind: record.kind,
      toolUseId: record.toolUseId,
      replacement: record.replacement,
    }));
  session.toolOutputArchive = restoreToolOutputArchive(session.messages, archiveRecords);
  session.pendingMeta = null;
}

export function replayInjectionsFromRecords(
  records: SessionRecord[],
  agent: Agent,
  systemInjections?: readonly SystemInjectionEntry[],
): void {
  agent.injections.drain();
  let lastCompactIdx = -1;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const rec = records[i];
    if (rec?.type === "compaction_mark" && isCompactionBoundary(rec)) {
      lastCompactIdx = i;
      break;
    }
  }
  // A queued user input that reached the model was persisted as a later
  // user_message (the queue drain records each delivered entry; the post-turn
  // promotion delivers every drained entry as ONE user_message joined by
  // "\n\n" in queue order). Replaying it again would re-deliver
  // already-answered input into the next turn's wire request, so each
  // delivery consumes the in-order pending entries that reconstruct its text
  // exactly — one entry for a per-entry delivery or dequeue marker, several
  // for a combined promotion — and only the leftovers replay. A partial
  // reconstruction consumes nothing (never guess), and queued slash commands
  // never reach the model as message text (the queue drain keeps them out of
  // the drained batch), so they never replay either.
  const undeliveredQueuedIdx = new Set<number>();
  const pendingQueue: { idx: number; text: string }[] = [];
  const consumeDelivery = (delivered: string): void => {
    // Whole-text match first: a per-entry delivery consumes its own entry even
    // when that entry contains "\n\n" (which the greedy split below could
    // otherwise mis-decompose against other pendings).
    for (const pending of pendingQueue) {
      if (!undeliveredQueuedIdx.has(pending.idx)) continue;
      if (pending.text === delivered) {
        undeliveredQueuedIdx.delete(pending.idx);
        return;
      }
    }
    const matched: number[] = [];
    let pos = 0;
    for (const pending of pendingQueue) {
      if (!undeliveredQueuedIdx.has(pending.idx)) continue;
      if (pos >= delivered.length) break;
      if (!delivered.startsWith(pending.text, pos)) continue;
      const end = pos + pending.text.length;
      if (end === delivered.length) {
        matched.push(pending.idx);
        pos = end;
        break;
      }
      if (delivered.slice(end, end + 2) !== "\n\n") continue;
      matched.push(pending.idx);
      pos = end + 2;
    }
    if (pos !== delivered.length) return;
    for (const idx of matched) undeliveredQueuedIdx.delete(idx);
  };
  for (let i = lastCompactIdx + 1; i < records.length; i += 1) {
    const rec = records[i];
    if (rec?.type === "injection_queued") {
      if (rec.source === "user") {
        if (rec.text.trim().startsWith("/")) continue;
        undeliveredQueuedIdx.add(i);
        pendingQueue.push({ idx: i, text: rec.text });
      }
      continue;
    }
    const delivered =
      rec?.type === "user_message"
        ? rec.content
        : rec?.type === "injection_dequeued"
          ? rec.text
          : null;
    if (delivered === null) continue;
    consumeDelivery(delivered);
  }
  for (let i = lastCompactIdx + 1; i < records.length; i += 1) {
    const rec = records[i];
    if (rec?.type !== "injection_queued") continue;
    if (rec.source === "user" && !undeliveredQueuedIdx.has(i)) continue;
    agent.pushInjectionInMemoryOnly(rec.text);
  }
  const activeSessionId = getActiveSessionId();
  const storedSystemInjections =
    systemInjections ??
    (activeSessionId ? loadSystemInjectionsForSession(activeSessionId, process.cwd()) : []);
  for (const entry of systemInjectionsAfterCompact(
    storedSystemInjections,
    lastCompactIdx,
    records.length,
  )) {
    agent.pushInjectionInMemoryOnly(entry.text);
  }
}

export function hasMessageRecords(session: Session): boolean {
  return session.records.some(isMessageRecord);
}

export function isMessageRecord(record: SessionRecord): boolean {
  return record.type === "user_message" || record.type === "assistant_message";
}

/**
 * How to come back to this session. A session the user named is resumed by that name,
 * which is what they will recognise; the id carries sessions they never renamed. Only a
 * user-assigned title is offered, because that is the only one resume looks up — a
 * generated one would print a command that finds nothing.
 */
export function resumeExitText(
  sessionId: string,
  command = "otherside",
  worktreeName?: string | null,
  customTitle?: string | null,
): string {
  const worktreeFlag = worktreeName ? `--worktree ${worktreeName} ` : "";
  const target = customTitle ? quoteTitleForResume(customTitle) : sessionId;
  return `\n${dim("Resume this session with:")}\n${dim(`${command} ${worktreeFlag}--resume ${target}`)}\n`;
}
