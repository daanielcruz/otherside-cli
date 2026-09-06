import { isImmediateSlash } from "@/commands/immediate.ts";
import { createDesignController, type DesignController } from "@/design/controller.ts";
import type { PermissionResolver } from "@/engine/agents/agent-context.ts";
import {
  formatForkSuccessFeedback,
  launchForkFromDirective,
} from "@/engine/background/subagents/fork/spawn-from-directive.ts";
import { createRunSkill, type RunSkillFn } from "@/engine/background/subagents/skill-runner.ts";
import * as backgroundControllers from "@/engine/background/tasks/background-controllers.ts";
import type { Agent } from "@/engine/queue/index.ts";
import { resolvePermission } from "@/engine/queue/runtime/permission-resolution.ts";
import { makeRequestContext } from "@/engine/queue/runtime/request-context.ts";
import { TurnGuard } from "@/engine/queue/runtime/turn/guard.ts";
import { createTurnLifecycle } from "@/engine/queue/runtime/turn/lifecycle.ts";
import { createClearTranscript } from "@/engine/session/clear-transcript.ts";
import {
  nowIso,
  revokeLastUnansweredUserMessage,
  type Session,
  sessionBrokerStateKey,
} from "@/engine/session/index.ts";
import { createResumeSession, type ResumeSessionFn } from "@/engine/session/resume.ts";
import {
  createRewindToTranscriptId,
  type RewindToTranscriptIdFn,
} from "@/engine/session/rewind.ts";
import { sessionMetaFromBrokerState } from "@/engine/session/state.ts";
import { createRecordProviderUsage } from "@/engine/session/usage/record-provider-usage.ts";
import type { ErrorActionId } from "@/engine/transport/error-meta.ts";
import { type UserConfig, updateConfig } from "@/kernel/config/config.ts";
import { setActivePasteStore } from "@/kernel/std/paste/registry.ts";
import { makeMacrotaskBatch } from "@/kernel/std/perf/macrotask-batch.ts";
import { createAutoClearDispatch } from "@/kernel/std/state/auto-clear-dispatch.ts";
import type { ErrorMeta } from "@/kernel/std/types/error-meta.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import type { MutableRef } from "@/kernel/std/types/state.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import { dispatch } from "@/store/app-store/index.ts";
import { getQueueMessages, queueActions, sessionTitleActions } from "@/store/index.ts";
import { setLiveOutputTokens } from "@/store/live-tokens/index.ts";
import { overlayStack } from "@/store/overlay-stack/index.ts";
import { createPasteStore } from "@/store/paste-store/index.ts";
import { setPromptText } from "@/store/prompt/index.ts";
import {
  pendingBrokerMetaRef,
  pendingRewindPersistRef,
  sessionFinalizersRef,
  suppressBrokerPersistenceRef,
} from "@/store/session-lifecycle/index.ts";
import { getTranscriptEntries } from "@/store/transcript/index.ts";
import { transcriptLiveStore } from "@/store/transcript/live.ts";
import {
  compactRunningRef,
  freezeObserverRef,
  generatorActiveRef,
  handleSlashRef,
  recordPanelCommitRef,
  runningRef,
  runSubmittedTurnRef,
  skillAbortRef,
  turnStartedAtRef,
} from "@/store/turn-run/index.ts";
import { pendingErrorRevokeRef } from "@/store/turn-status/index.ts";
import {
  agentModelByCallIdRef,
  currentAgentCallIdRef,
  currentTurnUserIdRef,
  forkToCallIdRef,
  nextTranscriptId,
} from "@/store/turn-tracking/index.ts";
import { createAgentTranscriptHelpers } from "@/ui/app/agent-transcript.ts";
import { createBtwController } from "@/ui/app/controllers/btw.ts";
import { createThinkingStatusController } from "@/ui/app/controllers/thinking-status.ts";
import {
  applyInterruptionResult,
  computeInterruptionResult,
} from "@/ui/app/dispatch/apply-interruption.ts";
import { createRequestBackgroundResume } from "@/ui/app/dispatch/background-resume.ts";
import { createForkEventRouter } from "@/ui/app/dispatch/fork-event-router.ts";
import { createPromptHookGate } from "@/ui/app/dispatch/prompt-hook-gate.ts";
import { createHandleSlash } from "@/ui/app/dispatch/slash.ts";
import { createApplySlashResult, createRecordPanelCommit } from "@/ui/app/dispatch/slash-result.ts";
import { createRunSubmittedTurn } from "@/ui/app/dispatch/submitted-turn.ts";
import type { DispatchLoopDeps } from "@/ui/app/dispatch/types.ts";
import { submitToViewedAgent } from "@/ui/app/dispatch/viewed-agent-submit.ts";
import { createPendingInputDrainer } from "@/ui/app/drain/pending-input-drainer.ts";
import { createPostTurnDrain } from "@/ui/app/drain/post-turn.ts";
import { createQueueHelpers } from "@/ui/app/drain/queue.ts";
import { createUsageSetters } from "@/ui/app/usage-setters.ts";
import { findRewindCutIndex } from "@/ui/transcript/records/entry-builders.ts";
import { sessionRecordsToTranscript } from "@/ui/transcript/records/from-records.ts";
import { estimateTokens } from "@/ui/transcript/stats.ts";
import { createTranscriptSetters } from "@/ui/transcript/stream/setters.ts";

const AUTO_RESUME_HOLD_MS = 50;

export function shouldQueueSubmission(text: string, running: boolean): boolean {
  if (!running) return false;
  const trimmed = text.trim();
  return !trimmed.startsWith("/") || !isImmediateSlash(trimmed);
}

export interface StringViewDispatchDeps {
  session: Session;
  broker: Broker;
  agent: Agent;
  runtimeConfig: UserConfig;
  version: string;
  exit: () => void;
}

/**
 * Wires the prompt to a real model turn on the string-view renderer. It reuses the
 * shared turn runner (`createRunSubmittedTurn`) with the renderer-agnostic streaming
 * setters — which write the settled and live transcript stores the string view already
 * renders — so a submitted message runs a turn, streams into the transcript, and
 * settles. UI-only concerns (progress spinner, error/quota panels, agent nesting,
 * usage) are stubbed for now; the chrome that consumes them is ported separately.
 */
export interface StringViewDispatch {
  submit: (text: string) => void;
  /**
   * Aborts the in-flight turn (Ctrl+C mid-stream) and clears its live state.
   * Answers whether there was a turn to abort, so a caller that consumes the
   * key can tell acting apart from doing nothing.
   */
  cancel: () => boolean;
  requestBackgroundResume: () => void;
  backgroundCurrentTool: () => boolean;
  restoreQueued: () => string | null;
  rewindToTranscriptId: RewindToTranscriptIdFn;
  resumeSession: ResumeSessionFn;
  // Opener payloads for the credential overlays (login/logout). The flows
  // themselves touch credential material and are validated owner-side.
  broker: Broker;
  /** The session this dispatch runs turns for; overlays that act on it read it here. */
  session: Session;
  /** Design start needs session, broker and agent together, which only this owns. */
  designController: () => DesignController;
  config: UserConfig;
  onConfigChange: (config: UserConfig) => void;
  dispose: () => void;
}

export function createStringViewSubmit(deps: StringViewDispatchDeps): StringViewDispatch {
  const { session, broker, agent, runtimeConfig } = deps;
  const transcriptBatch = makeMacrotaskBatch();
  const setters = createTranscriptSetters(transcriptBatch);
  const turnGuard = new TurnGuard();
  const noop = (): void => {};
  // Frames are derived from stores, so session operations have no retained render
  // surface to reset. This dispatch path also owns no session finalizer registry.
  const resetRenderSurface = noop;
  const runSessionFinalizers = noop;
  const setBusy = (busy: boolean): void => {
    dispatch({ type: "view/setBusy", busy });
  };
  const setProgressStartedAt = (startedAt: number | null): void => {
    dispatch({ type: "view/setProgressStartedAt", startedAt });
  };
  // The status line's context readout and the right-region token counter read the
  // usage slice; wire the turn runner's usage setters to it so both reflect the turn.
  const usageSetters = createUsageSetters();
  const setContextWarningSuppressed = (suppressed: boolean): void =>
    dispatch({ type: "view/setContextWarningSuppressed", suppressed });
  // Records each completed turn's provider usage into the store — the actual source of
  // the context readout. Without it the status line and token counter stay at zero.
  const recordProviderUsage = createRecordProviderUsage({
    session,
    setMainTokenTotals: usageSetters.setMainTokenTotals,
    setMainLastContext: usageSetters.setMainLastContext,
    setContextWarningSuppressed,
    setUsageByProvider: usageSetters.setUsageByProvider,
    setOfflineUsageByProvider: usageSetters.setOfflineUsageByProvider,
  });

  const thinkingStatus = createThinkingStatusController();

  // Queue a message submitted while a turn is streaming, and drain it after the turn.
  const pasteStoreRef = { current: createPasteStore(session.id) };
  // The prompt collapses a large/multiline paste into a `[Pasted text]` placeholder
  // backed by the active paste store, and the turn submission expands that same store.
  // Register this dispatch's store so both sides share it; resume re-registers its swap.
  setActivePasteStore(pasteStoreRef.current);
  const runtimeConfigRef = { current: runtimeConfig };
  const persistedSessionBrokerStateRef = { current: sessionBrokerStateKey(broker.read()) };
  const deactivateBrokerPersistence = broker.subscribe((next) => {
    const key = sessionBrokerStateKey(next);
    if (key === persistedSessionBrokerStateRef.current) return;
    persistedSessionBrokerStateRef.current = key;
    if (suppressBrokerPersistenceRef.current) return;
    const meta = sessionMetaFromBrokerState(session, next, nowIso());
    pendingBrokerMetaRef.current = meta;
    session.pendingMeta = meta;
  });
  const compactTerminalRef = { current: false };
  const { pushQueued, popAllQueued, applyPendingChange } = createQueueHelpers({
    pasteStoreRef,
    session,
    agent,
    broker,
    compactTerminalRef,
    runtimeConfigRef,
  });
  const postTurnDrain = createPostTurnDrain({ setTranscript: setters.setTranscript });
  // Messages queued while a turn runs join that same turn at its next boundary; only
  // what is left over (slash commands) starts a new turn through postTurnDrain.
  const pendingInputDrainer = createPendingInputDrainer();

  // The running tool entry stashes its serialized call args in `text`; the
  // completed entry lifts that into `input`, which the header reads to show the
  // file path / line range / command. A stubbed writer left the args empty, so
  // Read/Edit/Bash headers rendered with no target. Share the store's call-id
  // route map so backgrounded-agent identities resolve the same as the observer.
  const agentTranscript = createAgentTranscriptHelpers({
    setTranscript: setters.setTranscript,
    agentModelByCallIdRef,
  });

  // A fork a slash command starts has no tool call and no live turn to carry
  // its events, so they are routed here instead — onto the same skill row and
  // the same agent-identity update the turn path writes.
  const { routeForkEvent } = createForkEventRouter({
    setTranscript: setters.setTranscript,
    forkToCallIdRef,
    agentModelByCallIdRef,
    setAgentNested: agentTranscript.setAgentNested,
    recordProviderUsage,
    broker,
  });

  // Slash commands: reuse the shared handler (createHandleSlash) with the real clear +
  // apply-result machinery; UI-chrome-only deps (busy/progress/finalizers/render-surface)
  // are stubbed until their surfaces are ported.
  const clearTranscript = createClearTranscript({
    session,
    broker,
    agent,
    sessionTitle: sessionTitleActions,
    createPasteStore,
    setTranscript: setters.setTranscript,
    setStreamingId: setters.setStreamingId,
    setStreamingText: setters.setStreamingText,
    setStreamingThinking: setters.setStreamingThinking,
    setStreamingCommittedLen: setters.setStreamingCommittedLen,
    setBusy,
    setProgressStartedAt,
    setProgressInputTokens: noop,
    setLiveOutputTokens,
    setMainLastContext: usageSetters.setMainLastContext,
    dispatch,
    queueActions,
    transcriptBatch,
    resetRenderSurface,
    runSessionFinalizers,
    abortAllForkControllers: noop,
    runningRef,
    turnGuard,
    skillAbortRef,
    currentAgentCallIdRef,
    generatorActiveRef,
    compactTerminalRef,
    pasteStoreRef,
  });

  const rewindToTranscriptId = createRewindToTranscriptId({
    session,
    broker,
    agent,
    queueActions,
    getRuntimeConfig: () => runtimeConfigRef.current,
    setTranscript: setters.setTranscript,
    setMainLastContext: usageSetters.setMainLastContext,
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
  });
  const resumeSession = createResumeSession({
    session,
    broker,
    agent,
    sessionTitle: sessionTitleActions,
    createPasteStore,
    recordsToTranscript: sessionRecordsToTranscript,
    getRuntimeConfig: () => runtimeConfigRef.current,
    setTranscript: setters.setTranscript,
    setMainLastContext: usageSetters.setMainLastContext,
    setUsageByProvider: usageSetters.setUsageByProvider,
    setMainTokenTotals: usageSetters.setMainTokenTotals,
    pasteStoreRef,
    suppressBrokerPersistenceRef,
    persistedSessionBrokerStateRef,
    nextTranscriptId,
    transcriptBatch,
    runSessionFinalizers,
    resetRenderSurface,
  });

  // The runner needs the resume driver, which is built from the loop deps this
  // applier is part of; the ref closes that circle without duplicating either.
  const runSkillRef: MutableRef<RunSkillFn> = { current: async () => {} };
  const applySlashResult = createApplySlashResult({
    runSkill: (name, args, raw) => runSkillRef.current(name, args, raw),
    runningRef,
    applyPendingChange,
    nextTranscriptId,
    setTranscript: setters.setTranscript,
    agent,
    runSubmittedTurnRef,
    transcriptBatch,
    session,
    broker,
  });
  recordPanelCommitRef.current = createRecordPanelCommit(applySlashResult);

  const handleErrorAction = (id: ErrorActionId): void => {
    if (id === "retry" || id === "continue-anyway") {
      pendingErrorRevokeRef.current = false;
      if (!runningRef.current) void runSubmittedTurnRef.current("");
      return;
    }
    if (id === "switch-model") {
      pendingErrorRevokeRef.current = false;
      overlayStack.open("model");
      return;
    }
    if (id === "compact") {
      pendingErrorRevokeRef.current = false;
      handleSlashRef.current("/compact");
      return;
    }
    if (pendingErrorRevokeRef.current) {
      revokeLastUnansweredUserMessage(session);
      pendingErrorRevokeRef.current = false;
    }
  };
  const surfaceError = (meta: ErrorMeta): void => {
    overlayStack.open("error", { meta, onAction: handleErrorAction });
  };
  const surfaceQuota = (): void => {
    overlayStack.open("quota", {
      onSwitchModel: () => {
        overlayStack.closeTop();
        overlayStack.open("model");
      },
      onDismiss: () => overlayStack.closeTop(),
    });
  };

  const turnLifecycle = createTurnLifecycle({
    runningRef,
    generatorActiveRef,
    compactRunningRef,
    turnStartedAtRef,
    setBusy,
    setProgressStartedAt,
    setLiveOutputTokens,
  });

  const btwController = createBtwController({
    btwAbortRef: { current: null },
    btwSessionIdRef: { current: null },
    btwSeqRef: { current: 0 },
    session,
    broker,
    runtimeConfigRef,
    recordProviderUsage,
  });
  const btwForkAnswer = (question: string, response: string): string | null => {
    const ctx: RequestContext = {
      ...makeRequestContext(agent.deps),
      parentMessages: [
        ...session.messages,
        { role: "user", content: [{ type: "text", text: question }] },
        { role: "assistant", content: [{ type: "text", text: response }] },
      ],
    };
    const resolver: PermissionResolver = (toolCall) =>
      resolvePermission(
        {
          agentDeps: agent.deps,
          injections: agent.injections,
          sessionAllowedToolPatterns: agent.sessionAllowedToolPatterns,
        },
        toolCall,
      );
    const result = launchForkFromDirective(question, ctx, resolver);
    return result === null ? null : formatForkSuccessFeedback(result);
  };
  const enterBtwMode = (question: string): void => {
    void btwController.runBtwTurn(question);
    overlayStack.open("btw", {
      forkAnswer: btwForkAnswer,
      abortPending: btwController.abortPending,
    });
  };

  const loopDeps = {
    session,
    broker,
    agent,
    runtimeConfig,
    version: deps.version,
    exit: deps.exit,
    transcript: getTranscriptEntries(),
    mainLastContext: {},
    turnGuard,
    turnLifecycle,
    clearTranscript,
    applySlashResult,
    enterBtwMode,
    slashLifecycle: { onSessionFinalize: noop },
    recordProviderUsage,
    pendingInputDrainer,
    postTurnDrain,
    pushQueued,
    agentBlockText: agentTranscript.agentBlockText,
    setAgentNested: agentTranscript.setAgentNested,
    setAgentBackgrounded: agentTranscript.setAgentBackgrounded,
    beginThinkingStatus: thinkingStatus.begin,
    endThinkingStatus: thinkingStatus.end,
    resetThinkingStatus: thinkingStatus.reset,
    transcriptBatch,
    setTranscript: setters.setTranscript,
    setStreamingId: setters.setStreamingId,
    setStreamingText: setters.setStreamingText,
    setStreamingThinking: setters.setStreamingThinking,
    setStreamingCommittedLen: setters.setStreamingCommittedLen,
    setCodexUsage: usageSetters.setCodexUsage,
    setMainTokenTotals: usageSetters.setMainTokenTotals,
    setMainLastContext: usageSetters.setMainLastContext,
    setProgressInputTokens: noop,
    setProgressStartedAt,
    setTasksExpanded: noop,
    setContextWarningSuppressed,
    setConfigInitialTab: noop,
    setLoginInitialProvider: noop,
    showErrorPanel: surfaceError,
    handleQuotaExhausted: surfaceQuota,
    showUnsupportedImageInput: noop,
    flushDeferredPersistence: async () => {},
    clearExitPending: noop,
    promptHistoryIndexRef: { current: null },
    pasteStoreRef,
  } as unknown as DispatchLoopDeps;

  // One resume driver for queued input, background results, and parked
  // notifications; it reserves the turn guard itself, so no caller starts a
  // second turn on top of one still unwinding.
  const requestBackgroundResume = createRequestBackgroundResume({
    ...loopDeps,
    autoResumeDispatch: createAutoClearDispatch({ holdMs: AUTO_RESUME_HOLD_MS }),
    getBgTasksOpen: () => false,
  });
  const requestBackgroundResumeRef: MutableRef<() => void> = {
    current: requestBackgroundResume,
  };
  // The skill runner reads the command's own frontmatter: an inline command
  // takes the shared turn funnel, a `context: fork` one runs as a subagent
  // under the shared abort handle, which is what Esc aborts.
  runSkillRef.current = createRunSkill({
    session,
    broker,
    agent,
    setTranscript: setters.setTranscript,
    skillAbortRef,
    turnGuard,
    runSubmittedTurnRef,
    requestBackgroundResumeRef,
    nextTranscriptId,
    routeForkEvent,
    turnLifecycle,
  });
  const handleSlash = createHandleSlash(loopDeps, requestBackgroundResume);
  handleSlashRef.current = handleSlash;
  const runSubmittedTurn = createRunSubmittedTurn(loopDeps, {
    handleSlash,
    requestBackgroundResume,
  });
  runSubmittedTurnRef.current = runSubmittedTurn;
  const promptHookGate = createPromptHookGate({
    runtimeConfig,
    setTranscript: setters.setTranscript,
  });

  const cancelTurn = (): boolean => {
    if (!turnGuard.active) return false;
    transcriptBatch.flushNow();
    const live = transcriptLiveStore.getState();
    const thinking = live.streamingThinking.trim();
    const entries =
      thinking.length > 0
        ? [
            ...getTranscriptEntries(),
            {
              id: nextTranscriptId("thinking_interrupted"),
              kind: "thinking" as const,
              text: thinking,
            },
          ]
        : getTranscriptEntries();
    const route = broker.read();

    turnGuard.abort();
    agent.cancel();
    for (const callId of backgroundControllers.callIds()) {
      const controller = backgroundControllers.get(callId);
      if (controller && !controller.isBackgrounded()) controller.abort?.();
    }
    skillAbortRef.current?.abort("user-cancel");
    freezeObserverRef.current?.();

    if (!compactRunningRef.current) {
      const result = computeInterruptionResult({
        entries,
        partialText: live.streamingText,
        committedLen: live.committedLen,
        streamingId: live.streamingId,
        currentTurnUserId: currentTurnUserIdRef.current,
        showFeedback: true,
        conversationMarker: getQueueMessages().length === 0,
        partialIdFallback: nextTranscriptId("assistant_interrupted"),
        interruptId: nextTranscriptId("interrupt"),
        provider: route.provider,
        model: route.model,
        nowIso: nowIso(),
      });
      applyInterruptionResult(result, {
        session,
        setTranscript: setters.setTranscript,
        setStreamingId: setters.setStreamingId,
        setStreamingText: setters.setStreamingText,
        setStreamingThinking: setters.setStreamingThinking,
        setStreamingCommittedLen: setters.setStreamingCommittedLen,
      });
    } else {
      setters.setStreamingId(null);
      setters.setStreamingText("");
      setters.setStreamingThinking("");
      setters.setStreamingCommittedLen(0);
    }

    currentAgentCallIdRef.current = null;
    setLiveOutputTokens(0);
    setProgressStartedAt(null);
    // Two flags say "the leader is working" and both have to answer here: the
    // store one drives the terminal's own progress indicator, the generator one
    // draws the progress block. Leaving the generator flag to the turn's own
    // teardown would keep the block alive until the awaited turn settles, and a
    // tool the client cannot abort holds that for as long as its own deadline.
    setBusy(false);
    generatorActiveRef.current = false;
    dispatch({ type: "view/setRetryStatus", status: null });
    return true;
  };

  return {
    rewindToTranscriptId,
    resumeSession,
    broker,
    session,
    designController: () =>
      createDesignController({
        broker,
        session,
        agent,
        version: deps.version,
        onFinalize: (handler) => {
          sessionFinalizersRef.current.push(handler);
        },
      }),
    config: runtimeConfig,
    onConfigChange: (next: UserConfig): void => {
      void updateConfig((cfg) => {
        Object.assign(cfg, next);
      });
    },
    submit: (text: string): void => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      if (trimmed.startsWith("/")) {
        // Slash commands govern the session, not the viewed thread — they keep
        // their global behavior even while an agent's document is open.
        if (shouldQueueSubmission(trimmed, runningRef.current)) {
          pushQueued(text);
          return;
        }
        if (handleSlash(text)) return;
        if (runningRef.current) {
          pushQueued(text);
          return;
        }
        void promptHookGate(text, (additionalContext) =>
          runSubmittedTurn(text, { additionalContext }),
        );
        return;
      }
      // An open agent document owns plain text: the header names it as the
      // addressee, so the message steers or re-runs THAT agent. Delivery is
      // independent of the main turn — steering never queues behind it.
      void (async () => {
        const routed = await submitToViewedAgent(text, {
          agent,
          pasteStoreRef,
          showUndeliverable: (reason) => {
            setters.setTranscript((t) => [
              ...t,
              { id: nextTranscriptId("notice"), kind: "system", text: reason, isError: true },
            ]);
          },
        });
        if (routed) return;
        if (shouldQueueSubmission(trimmed, runningRef.current) || runningRef.current) {
          pushQueued(text);
          return;
        }
        await promptHookGate(text, (additionalContext) =>
          runSubmittedTurn(text, { additionalContext }),
        );
      })();
    },
    cancel: cancelTurn,
    requestBackgroundResume,
    backgroundCurrentTool: agentTranscript.backgroundCurrentAgent,
    restoreQueued: popAllQueued,
    dispose: deactivateBrokerPersistence,
  };
}
