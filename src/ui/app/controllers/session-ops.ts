import { type MutableRefObject, useMemo } from "react";
import { createRunSkill } from "@/commands/index.ts";
import type { RunSkillFn } from "@/engine/background/subagents/skill-runner.ts";
import type { Agent } from "@/engine/queue/index.ts";
import type { TurnGuard } from "@/engine/queue/runtime/turn/guard.ts";
import type { TurnLifecycle } from "@/engine/queue/runtime/turn/lifecycle.ts";
import {
  type ClearTranscriptFn,
  createClearTranscript,
} from "@/engine/session/clear-transcript.ts";
import type { Session } from "@/engine/session/index.ts";
import { createResumeSession, type ResumeSessionFn } from "@/engine/session/resume.ts";
import {
  createRewindToTranscriptId,
  type RewindToTranscriptIdFn,
} from "@/engine/session/rewind.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { MacrotaskBatch } from "@/kernel/std/perf/macrotask-batch.ts";
import type { PasteStore } from "@/kernel/std/types/paste.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import {
  dispatch,
  getTranscriptEntries,
  overlayStack,
  queueActions,
  sessionTitleActions,
} from "@/store/index.ts";
import { setLiveOutputTokens } from "@/store/live-tokens/index.ts";
import { createPasteStore } from "@/store/paste-store/index.ts";
import { setPromptText } from "@/store/prompt/index.ts";
import {
  pendingBrokerMetaRef,
  pendingRewindPersistRef,
  suppressBrokerPersistenceRef,
} from "@/store/session-lifecycle/index.ts";
import {
  generatorActiveRef,
  runningRef,
  runSubmittedTurnRef,
  skillAbortRef,
} from "@/store/turn-run/index.ts";
import { compactTerminalRef } from "@/store/turn-status/index.ts";
import {
  currentAgentCallIdRef,
  nextTranscriptId,
  routeForkEventRef,
} from "@/store/turn-tracking/index.ts";
import type { UsageSetters } from "@/ui/app/usage-setters.ts";
import { findRewindCutIndex } from "@/ui/transcript/records/entry-builders.ts";
import { sessionRecordsToTranscript } from "@/ui/transcript/records/from-records.ts";
import { estimateTokens } from "@/ui/transcript/stats.ts";
import type { TranscriptSetters } from "@/ui/transcript/stream/setters.ts";

interface SessionOpsDeps {
  session: Session;
  broker: Broker;
  agent: Agent;
  turnGuard: TurnGuard;
  turnLifecycle: TurnLifecycle;
  requestBackgroundResumeRef: MutableRefObject<() => void>;
  transcriptBatch: MacrotaskBatch;
  resetRenderSurface: () => void;
  abortAllForkControllers: () => void;
  runSessionFinalizers: () => void;
  setTranscript: TranscriptSetters["setTranscript"];
  setStreamingId: TranscriptSetters["setStreamingId"];
  setStreamingText: TranscriptSetters["setStreamingText"];
  setStreamingThinking: TranscriptSetters["setStreamingThinking"];
  setStreamingCommittedLen: TranscriptSetters["setStreamingCommittedLen"];
  setBusy: (value: boolean | ((prev: boolean) => boolean)) => void;
  setProgressStartedAt: (value: number | null | ((prev: number | null) => number | null)) => void;
  setProgressInputTokens: (value: number | ((prev: number) => number)) => void;
  setMainLastContext: UsageSetters["setMainLastContext"];
  setUsageByProvider: UsageSetters["setUsageByProvider"];
  setMainTokenTotals: UsageSetters["setMainTokenTotals"];
  pasteStoreRef: MutableRefObject<PasteStore>;
  runtimeConfigRef: MutableRefObject<UserConfig>;
  persistedSessionBrokerStateRef: MutableRefObject<string>;
  flushDeferredPersistence: () => Promise<void>;
}

interface SessionOpsResult {
  clearTranscript: ClearTranscriptFn;
  runSkill: RunSkillFn;
  rewindToTranscriptId: RewindToTranscriptIdFn;
  resumeSession: ResumeSessionFn;
}

export function useSessionOps(deps: SessionOpsDeps): SessionOpsResult {
  const {
    session,
    broker,
    agent,
    turnGuard,
    turnLifecycle,
    requestBackgroundResumeRef,
    transcriptBatch,
    resetRenderSurface,
    abortAllForkControllers,
    runSessionFinalizers,
    setTranscript,
    setStreamingId,
    setStreamingText,
    setStreamingThinking,
    setStreamingCommittedLen,
    setBusy,
    setProgressStartedAt,
    setProgressInputTokens,
    setMainLastContext,
    setUsageByProvider,
    setMainTokenTotals,
    pasteStoreRef,
    runtimeConfigRef,
    persistedSessionBrokerStateRef,
  } = deps;

  const clearTranscript = useMemo(
    () =>
      createClearTranscript({
        session,
        broker,
        agent,
        sessionTitle: sessionTitleActions,
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
      }),
    [
      session,
      broker,
      agent,
      setTranscript,
      setStreamingId,
      setStreamingText,
      setStreamingThinking,
      setStreamingCommittedLen,
      setMainLastContext,
      transcriptBatch,
      runSessionFinalizers,
      resetRenderSurface,
      abortAllForkControllers,
    ],
  );

  const runSkill = useMemo(
    () =>
      createRunSkill({
        session,
        broker,
        agent,
        setTranscript,
        skillAbortRef,
        turnGuard,
        runSubmittedTurnRef,
        requestBackgroundResumeRef,
        nextTranscriptId,
        routeForkEvent: (event) => routeForkEventRef.current(event),
        turnLifecycle,
      }),
    [session, broker, agent, setTranscript, turnLifecycle, requestBackgroundResumeRef],
  );

  const rewindToTranscriptId = useMemo(
    () =>
      createRewindToTranscriptId({
        session,
        broker,
        agent,
        queueActions,
        getRuntimeConfig: () => runtimeConfigRef.current,
        setTranscript,
        setMainLastContext,
        setPromptText,
        pasteStoreRef,
        suppressBrokerPersistenceRef,
        persistedSessionBrokerStateRef,
        pendingRewindPersistRef,
        pendingBrokerMetaRef,
        overlayStack,
        transcriptBatch,
        getTranscriptEntries,
        resetRenderSurface,
        findRewindCutIndex,
        estimateTokens,
      }),
    [
      session,
      broker,
      agent,
      setTranscript,
      setMainLastContext,
      transcriptBatch,
      resetRenderSurface,
    ],
  );
  const resumeSession = useMemo(
    () =>
      createResumeSession({
        session,
        broker,
        agent,
        sessionTitle: sessionTitleActions,
        createPasteStore,
        recordsToTranscript: sessionRecordsToTranscript,
        getRuntimeConfig: () => runtimeConfigRef.current,
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
      }),
    [
      session,
      broker,
      agent,
      setTranscript,
      setMainLastContext,
      setUsageByProvider,
      setMainTokenTotals,
      runSessionFinalizers,
      transcriptBatch,
      resetRenderSurface,
      nextTranscriptId,
    ],
  );

  return { clearTranscript, runSkill, rewindToTranscriptId, resumeSession };
}
