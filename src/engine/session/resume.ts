import type { MutableRefObject } from "react";
import {
  getActiveSessionId,
  setTaskOutputSession,
} from "@/engine/background/tasks/output-files.ts";
import type { Agent } from "@/engine/queue/index.ts";
import { restoreGoalFromRecords } from "@/engine/queue/state.ts";
import { estimateHarnessTokens } from "@/engine/session/compact/harness-baseline.ts";
import { setEstimatedUsage, setLastUsage } from "@/engine/session/compact/last-usage.ts";
import { roughTokenCountEstimationForMessages } from "@/engine/session/compact/token-count.ts";
import { cleanupSessionHeapState } from "@/engine/session/finalize.ts";
import {
  latestContextUsageSnapshotFromSessionRecords,
  loadSessionForResume,
  loadSessionTitle,
  resolveSessionBrokerState,
  type Session,
  type SessionBrokerState,
  type SessionRecord,
  sessionBrokerStateKey,
  type UsageRecord,
} from "@/engine/session/index.ts";
import { isCompactionBoundary } from "@/engine/session/record/index.ts";
import type { ContentReplacementSessionRecord } from "@/engine/session/record/schema.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import {
  loadSystemInjectionsForSession,
  type SystemInjectionEntry,
  systemInjectionsAfterCompact,
} from "@/engine/session/system-injection-store.ts";
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
import { reconstructContentReplacementState } from "@/engine/tool-result-storage/index.ts";
import { sanitizeMessages } from "@/engine/translator/index.ts";
import { dim } from "@/ink";
import { fastModeForProvider, type UserConfig } from "@/kernel/config/config.ts";
import { setTrackedCwd } from "@/kernel/std/state/cwd-state.ts";
import type { PasteStore } from "@/kernel/std/types/paste.ts";
import type { BrokerHandle } from "@/kernel/std/types/request.ts";

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
  pasteStoreRef: MutableRefObject<PasteStore>;
  suppressBrokerPersistenceRef: MutableRefObject<boolean>;
  persistedSessionBrokerStateRef: MutableRefObject<string>;
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
    const { records, modelRecords, usageRecords, chainHead, cwd, tailRecords } =
      await loadSessionForResume(id);
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
    // Cap projection input at the tail (mounted window is 200/50); do not build
    // transcript entries for the entire retained record set.
    const entries = recordsToTranscript(tailRecords);
    // A goal set in a prior run lives only in-memory; re-derive it from the
    // transcript's goal hook_events so an unmet goal keeps blocking after resume.
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
      // startup path (`roughTokenCountEstimationForMessages(session.messages)`).
      messagesBaseline: roughTokenCountEstimationForMessages(resumedMessages),
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
    restoreBrokerStateOnResume({
      broker,
      target: restoredBrokerState,
      runtimeConfig: getRuntimeConfig(),
      suppressRef: suppressBrokerPersistenceRef,
      persistedRef: persistedSessionBrokerStateRef,
    });
    sessionTitle.setAttempted(true);
    sessionTitle.setTitle(null);
    void loadSessionTitle(id).then((resumedTitle) => {
      if (session.id !== id) return;
      sessionTitle.setTitle(resumedTitle);
    });
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
  suppressRef: MutableRefObject<boolean>;
  persistedRef: MutableRefObject<string>;
}): void {
  const { broker, target, runtimeConfig, suppressRef, persistedRef } = args;
  suppressRef.current = true;
  try {
    if (broker.read().provider !== target.provider) {
      broker.dispatch({
        kind: "set_provider",
        provider: target.provider,
        model: target.model,
        fastMode: target.fastMode ?? fastModeForProvider(runtimeConfig, target.provider),
      });
    } else if (broker.read().model !== target.model) {
      broker.dispatch({
        kind: "set_provider",
        provider: target.provider,
        model: target.model,
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
  pasteStoreRef: MutableRefObject<PasteStore>;
  createPasteStore: (sessionId: string) => PasteStore;
  /** Precomputed model messages; when omitted, derived from modelRecords once. */
  messages?: ReturnType<typeof sanitizeMessages>;
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
  } = args;
  session.id = id;
  pasteStoreRef.current = createPasteStore(session.id);
  if (chainHead) session.chain.seed(chainHead);
  else session.chain.headUuid = null;
  session.records.splice(0, session.records.length, ...records);
  session.usageRecords.splice(0, session.usageRecords.length, ...usageRecords);
  session.systemInjections.splice(0, session.systemInjections.length, ...systemInjections);
  session.hookEvents.splice(0, session.hookEvents.length);
  const hydratedMessages = messages ?? sanitizeMessages(sessionRecordsToMessages(modelRecords));
  session.messages.splice(0, session.messages.length, ...hydratedMessages);
  const replacementRecords = records
    .filter((r): r is ContentReplacementSessionRecord => r.type === "content_replacement")
    .map((r) => ({
      kind: r.kind,
      toolUseId: r.toolUseId,
      replacement: r.replacement,
    }));
  session.contentReplacementState = reconstructContentReplacementState(
    session.messages,
    replacementRecords,
  );
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
  for (let i = lastCompactIdx + 1; i < records.length; i += 1) {
    const rec = records[i];
    if (rec?.type === "injection_queued") agent.pushInjectionInMemoryOnly(rec.text);
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

export function resumeExitText(
  sessionId: string,
  command = "otherside",
  worktreeName?: string | null,
): string {
  const worktreeFlag = worktreeName ? `--worktree ${worktreeName} ` : "";
  return `\n${dim("Resume this session with:")}\n${dim(`${command} ${worktreeFlag}--resume ${sessionId}`)}\n`;
}
