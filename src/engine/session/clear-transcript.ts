import { randomUUID } from "node:crypto";
import type { MutableRefObject } from "react";
import { notifySubscribers as notifyTaskSubscribers } from "@/engine/background/tasks/index.ts";
import { setTaskOutputSession } from "@/engine/background/tasks/output-files.ts";
import type { Agent } from "@/engine/queue/index.ts";
import type { TurnGuard } from "@/engine/queue/runtime/turn/guard.ts";
import { estimateHarnessTokens } from "@/engine/session/compact/harness-baseline.ts";
import { clearLastUsage } from "@/engine/session/compact/last-usage.ts";
import { cleanupSessionHeapState } from "@/engine/session/finalize.ts";
import { type Session, sessionMetaFromBrokerState } from "@/engine/session/index.ts";
import { nowIso } from "@/engine/session/record/schema.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import type { SessionTitleSink } from "@/engine/session/resume.ts";
import type { ContextUsageSnapshot } from "@/engine/session/usage/snapshot.ts";
import { initScratchpadDir } from "@/harness/routines/scratchpad.ts";
import type { PasteStore } from "@/kernel/std/types/paste.ts";
import type { BrokerHandle } from "@/kernel/std/types/request.ts";

export interface ClearTranscriptDeps {
  session: Session;
  broker: BrokerHandle;
  agent: Agent;
  sessionTitle: SessionTitleSink;
  createPasteStore: (sessionId: string) => PasteStore;
  setTranscript: (
    value:
      | readonly TranscriptEntry[]
      | ((prev: readonly TranscriptEntry[]) => readonly TranscriptEntry[]),
  ) => void;
  setStreamingId: (id: string | null) => void;
  setStreamingText: (text: string) => void;
  setStreamingThinking: (text: string) => void;
  setStreamingCommittedLen: (value: number) => void;
  setBusy: (busy: boolean) => void;
  setProgressStartedAt: (at: number | null) => void;
  setProgressInputTokens: (tokens: number) => void;
  setLiveOutputTokens: (tokens: number) => void;
  setMainLastContext: (snapshot: ContextUsageSnapshot) => void;
  dispatch: (action: { readonly type: "view/setRetryStatus"; readonly status: null }) => void;
  queueActions: { clear: () => void };
  transcriptBatch: { flushNow: () => void };
  resetRenderSurface: () => void;
  runSessionFinalizers: () => void;
  abortAllForkControllers: () => void;
  runningRef: MutableRefObject<boolean>;
  turnGuard: TurnGuard;
  skillAbortRef: MutableRefObject<AbortController | null>;
  currentAgentCallIdRef: MutableRefObject<string | null>;
  generatorActiveRef: MutableRefObject<boolean>;
  compactTerminalRef: MutableRefObject<boolean>;
  pasteStoreRef: MutableRefObject<PasteStore>;
}

export type ClearTranscriptFn = () => void;

export function createClearTranscript(deps: ClearTranscriptDeps): ClearTranscriptFn {
  const {
    session,
    broker,
    agent,
    sessionTitle,
    createPasteStore,
    setTranscript,
    setStreamingId,
    setStreamingText,
    setStreamingThinking,
    setStreamingCommittedLen,
    setBusy,
    setProgressStartedAt,
    setProgressInputTokens,
    setLiveOutputTokens,
    setMainLastContext,
    dispatch,
    queueActions,
    transcriptBatch,
    resetRenderSurface,
    runSessionFinalizers,
    abortAllForkControllers,
    runningRef,
    turnGuard,
    skillAbortRef,
    currentAgentCallIdRef,
    generatorActiveRef,
    compactTerminalRef,
    pasteStoreRef,
  } = deps;

  return function clearTranscript(): void {
    // Clearing mid-turn cancels the live turn: abort() bumps the generation so
    // that turn's finally settles to a no-op (no output appended, no resume).
    if (runningRef.current) turnGuard.abort();
    agent.cancel();
    abortAllForkControllers();
    skillAbortRef.current?.abort("user-cancel");
    skillAbortRef.current = null;
    currentAgentCallIdRef.current = null;
    runningRef.current = false;
    generatorActiveRef.current = false;
    compactTerminalRef.current = false;
    setBusy(false);
    setProgressStartedAt(null);
    setProgressInputTokens(0);
    setLiveOutputTokens(0);
    dispatch({ type: "view/setRetryStatus", status: null });
    setStreamingId(null);
    setStreamingText("");
    setStreamingThinking("");
    setStreamingCommittedLen(0);
    queueActions.clear();
    pasteStoreRef.current.clear();
    resetRenderSurface();
    setTranscript([]);
    transcriptBatch.flushNow();
    session.messages.splice(0);
    session.records.splice(0);
    delete session.contentReplacementState;
    cleanupSessionHeapState(session.id, session.storageCwd);
    runSessionFinalizers();
    session.id = randomUUID();
    session.worktree = null;
    session.cwd = session.storageCwd;
    // Rebind the MAIN task scope to the new session before waking the task
    // subscribers: they re-hydrate lazily on next read, and without the rebind
    // that read would resolve to the previous session's directory and
    // resurrect its completed records.
    setTaskOutputSession({ sessionId: session.id, cwd: process.cwd() });
    notifyTaskSubscribers();
    initScratchpadDir(session.storageCwd, session.id);
    pasteStoreRef.current = createPasteStore(session.id);
    session.chain.headUuid = null;
    sessionTitle.reset();
    const brokerNow = broker.read();
    session.pendingMeta = sessionMetaFromBrokerState(session, brokerNow, nowIso());
    setMainLastContext({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: estimateHarnessTokens(brokerNow.provider, brokerNow.model),
      cacheCreationInputTokens: 0,
    });
    clearLastUsage();
    agent.resetMicrocompactState();
    agent.resetSessionScopedPermissions();
  };
}
