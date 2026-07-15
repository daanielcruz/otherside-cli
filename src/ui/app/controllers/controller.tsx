import { useEffect, useMemo, useRef, useState } from "react";
import { subscribe as subscribeTasks } from "@/engine/background/tasks/index.ts";
import { getProviderConfig } from "@/engine/contract/registry.ts";
import type { Agent } from "@/engine/queue/index.ts";
import { createTurnLifecycle } from "@/engine/queue/runtime/turn/lifecycle.ts";
import type { Session } from "@/engine/session/index.ts";
import { useApp, useStdout } from "@/ink";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import { dispatch, transcriptActions, useQueueMessages } from "@/store/index.ts";
import { setLiveOutputTokens } from "@/store/live-tokens/index.ts";
import { setPromptText, usePromptSelector } from "@/store/prompt/index.ts";
import {
  compactRunningRef,
  generatorActiveRef,
  onSubmitRef,
  runningRef,
  runSubmittedTurnRef,
  turnStartedAtRef,
} from "@/store/turn-run/index.ts";
import { compactTerminalRef } from "@/store/turn-status/index.ts";
import { nextTranscriptId } from "@/store/turn-tracking/index.ts";
import { createCancellationStage } from "@/ui/app/controllers/cancellation.ts";
import { useOverlayWiring } from "@/ui/app/controllers/overlay-wiring.ts";
import { useSessionOps } from "@/ui/app/controllers/session-ops.ts";
import { useThinkingStatusController } from "@/ui/app/controllers/thinking-status.ts";
import { useTurnWiring } from "@/ui/app/controllers/turn-wiring.ts";
import { createDispatchLoop } from "@/ui/app/dispatch/loop.ts";
import { createQueueHelpers } from "@/ui/app/drain/queue.ts";
import { useAppOverlays } from "@/ui/app/hooks/use-app-overlays.ts";
import { useAppProgress } from "@/ui/app/hooks/use-app-progress.ts";
import { useAppSessionRuntime } from "@/ui/app/hooks/use-app-session-runtime.ts";
import { useAppTaskState } from "@/ui/app/hooks/use-app-task-state.ts";
import { useAppTranscript } from "@/ui/app/hooks/use-app-transcript.ts";
import { useAppTurnRuntime } from "@/ui/app/hooks/use-app-turn-runtime.ts";
import { useAppUsage } from "@/ui/app/hooks/use-app-usage.ts";
import { AppView } from "@/ui/app/mount.tsx";
import { shellChromeState } from "@/ui/chrome/layout/shell.tsx";
import { panelChromeState } from "@/ui/chrome/overlay.ts";
import { usePendingInteractive } from "@/ui/hooks/use-pending-interactive.ts";
import { useThemeBootstrap } from "@/ui/hooks/use-theme-bootstrap.ts";
import { useGlobalInput } from "@/ui/keybindings/useGlobalInput.ts";
import type { OverlayName } from "@/ui/panels/registry.tsx";
import type { TranscriptEntry } from "@/ui/transcript/types";

export interface AppProps {
  broker: Broker;
  session: Session;
  agent: Agent;
  config: UserConfig;
  version: string;
  initialOverlay?: OverlayName | undefined;
  initialOverlayChain?: OverlayName[] | undefined;
  initialLoginProvider?: ProviderId | undefined;
  greeting?: string | undefined;
  initialTranscript?: TranscriptEntry[] | undefined;
}

export type { RewindMode } from "@/engine/session/rewind.ts";
export function AppController({
  broker,
  session,
  agent,
  config,
  version,
  initialOverlay,
  initialOverlayChain,
  initialLoginProvider,
  greeting,
  initialTranscript,
}: AppProps): React.JSX.Element {
  const { exit } = useApp();
  useStdout();
  const [state, setState] = useState(broker.read());
  const [runtimeConfig, setRuntimeConfig] = useState(config);
  const runtimeConfigRef = useRef(runtimeConfig);
  runtimeConfigRef.current = runtimeConfig;
  const {
    transcript,
    displayTranscript,
    liveEntries,
    setTranscript,
    setStreamingId,
    setStreamingText,
    setStreamingThinking,
    setStreamingCommittedLen,
    transcriptBatch,
  } = useAppTranscript({ initialTranscript });
  const {
    busy,
    setBusy,
    progressStartedAt,
    setProgressStartedAt,
    viewState,
    quotaPanel,
    errorPanel,
    retryStatus,
    setProgressInputTokens,
    spinnerMode,
    thinkingStatus,
    turnVerb,
    progressTipIndex,
    exitPendingKey,
    armExitPending,
    clearExitPending,
    isExitArmed,
    autoResumeDispatch,
    flushParkedDispatch,
    cancellationGraceDispatch,
  } = useAppProgress();
  const {
    aiTitle,
    overlayOpenStack,
    overlay,
    configInitialTab,
    setConfigInitialTab,
    loginInitialProvider,
    setLoginInitialProvider,
    closeOverlay,
  } = useAppOverlays({
    session,
    initialOverlay,
    initialOverlayChain,
    initialLoginProvider,
  });
  const lowerPanelActive = usePromptSelector((s) => s.menuOpen);
  const pendingInteractive = usePendingInteractive();
  const promptText = usePromptSelector((s) => s.text);
  const queuedMessages = useQueueMessages();
  const {
    bgTasks,
    setBgTasks,
    workflowTasks,
    setWorkflowTasks,
    panelAgents,
    bgTasksOpen,
    getBgTasksOpen,
    setBgTasksOpen,
    bgPillFocused,
    workflowDetailTargetId,
    workflowDetailOpen,
    panelFocused,
    setPanelFocused,
    panelSelection,
    setPanelSelection,
    panelSelectionValue,
    panelStatusHint,
    viewingAgentId,
    tasksExpanded,
    setTasksExpanded,
    remoteSyncStatus,
  } = useAppTaskState({ overlay, pendingInteractive, quotaPanel, errorPanel });

  const {
    usageByProvider,
    offlineUsageByProvider,
    codexUsage,
    mainTokenTotals,
    mainLastContext,
    setUsageByProvider,
    setCodexUsage,
    setMainTokenTotals,
    setMainLastContext,
    usageWarning,
    contextWarningSuppressed,
    setContextWarningSuppressed,
    recordProviderUsage,
    clipboardImageActive,
    activeGoalLabel,
    contextBanner,
    activeContextTotal,
    autoCompactWarningPct,
    fallbackInputTokens,
    mainOutputTokens,
  } = useAppUsage({ session, broker, initialTranscript, state, runtimeConfig, busy });
  const logEpoch = viewState.logEpoch;
  const btwMode = viewState.btwMode;
  useThemeBootstrap(runtimeConfig.theme);

  const { pasteStoreRef, requestBackgroundResumeRef, turnGuard } = useAppTurnRuntime({
    session,
    broker,
    getBgTasksOpen,
    setBgTasks,
    setBgTasksOpen,
    setWorkflowTasks,
    setTranscript,
    flushParkedDispatch,
  });
  const {
    promptHistoryRef,
    promptHistoryIndexRef,
    runSessionFinalizers,
    slashLifecycle,
    persistedSessionBrokerStateRef,
    flushDeferredPersistence,
  } = useAppSessionRuntime({ session, broker, setState, setMainLastContext });
  const turnLifecycle = useMemo(
    () =>
      createTurnLifecycle({
        runningRef,
        generatorActiveRef,
        compactRunningRef,
        turnStartedAtRef,
        setBusy,
        setProgressStartedAt,
        setLiveOutputTokens,
      }),
    [],
  );
  const thinkingController = useThinkingStatusController();
  const {
    begin: beginThinkingStatus,
    end: endThinkingStatus,
    reset: resetThinkingStatus,
  } = thinkingController;

  const resetRenderSurface = (): void => {
    transcriptActions.resetFlushCursor();
    dispatch({ type: "view/bumpLogEpoch" });
  };

  const showUnsupportedImageInput = (providerId: ProviderId): void => {
    const id = nextTranscriptId("image_unsupported");
    const label = getProviderConfig(providerId)?.provider.label ?? providerId;
    setTranscript((t) => [
      ...t,
      {
        id,
        kind: "system",
        text: `${label} cannot read images. Open /config and set an image parser provider so I can describe images for you, or switch to a vision-capable provider.`,
        isError: true,
      },
    ]);
  };

  // A task-store change can coincide with a cancelled turn settling while user
  // input is queued. It nudges the common driver but never arms a completion wake;
  // canResume derives that only from the input queue, injections, or emitQueue.
  useEffect(() => subscribeTasks(() => requestBackgroundResumeRef.current?.()), []);

  const queueHelpers = useMemo(
    () =>
      createQueueHelpers({
        pasteStoreRef,
        session,
        agent,
        broker,
        compactTerminalRef,
        runtimeConfigRef,
      }),
    [session, agent, broker],
  );
  const { pushQueued, popAllQueued, applyPendingChange, enqueuePendingChange } = queueHelpers;

  const { abortAllForkControllers, handleQuotaExhausted, showErrorPanel, runCancellation } =
    createCancellationStage({
      session,
      agent,
      state,
      promptText,
      overlay,
      bgTasksOpen,
      setBgTasksOpen,
      bgPillFocused,
      lowerPanelActive,
      quotaPanel,
      errorPanel,
      closeOverlay,
      exit,
      turnGuard,
      requestBackgroundResumeRef,
      transcriptBatch,
      setTranscript,
      setStreamingId,
      setStreamingText,
      setStreamingThinking,
      setStreamingCommittedLen,
      setBusy,
      setProgressStartedAt,
      cancellationGraceDispatch,
      armExitPending,
      clearExitPending,
      isExitArmed,
      popAllQueued,
      resetRenderSurface,
    });

  const { clearTranscript, runSkill, rewindToTranscriptId, resumeSession } = useSessionOps({
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
    flushDeferredPersistence,
  });

  const {
    agentBlockText,
    setAgentNested,
    setAgentBackgrounded,
    backgroundCurrentAgent,
    pendingInputDrainer,
    postTurnDrain,
    promptHistoryNav,
    applySlashResult,
    recordPanelCommit,
    runBtwTurn,
    enterBtwMode,
    exitBtwMode,
  } = useTurnWiring({
    session,
    broker,
    agent,
    setTranscript,
    recordProviderUsage,
    handleQuotaExhausted,
    runSkill,
    applyPendingChange,
    transcriptBatch,
    runtimeConfigRef,
    promptHistoryRef,
    promptHistoryIndexRef,
  });
  useGlobalInput({
    overlay,
    broker,
    busy,
    backgroundCurrentAgent,
    panelAgents,
    workflowTasks,
    panelFocused,
    panelSelection,
    setPanelFocused,
    setPanelSelection,
    viewingAgentId,
    bgTasksOpen,
    bgTasks,
    bgPillFocused,
    promptText,
    setBgTasksOpen,
    setTasksExpanded,
    runCancellation,
    pendingInteractive,
    btwMode,
    exitBtwMode,
  });

  const { onSubmit, runSubmittedTurn, handleErrorAction, requestBackgroundResume } =
    createDispatchLoop({
      session,
      broker,
      agent,
      version,
      exit,
      runtimeConfig,
      transcript,
      mainLastContext,
      btwMode,
      turnGuard,
      turnLifecycle,
      autoResumeDispatch,
      getBgTasksOpen,
      clearTranscript,
      applySlashResult,
      runBtwTurn,
      enterBtwMode,
      recordProviderUsage,
      slashLifecycle,
      promptHistoryNav,
      pushQueued,
      pendingInputDrainer,
      postTurnDrain,
      agentBlockText,
      setAgentNested,
      setAgentBackgrounded,
      beginThinkingStatus,
      endThinkingStatus,
      resetThinkingStatus,
      setTranscript,
      setStreamingId,
      setStreamingText,
      setStreamingThinking,
      setStreamingCommittedLen,
      setCodexUsage,
      setMainTokenTotals,
      setMainLastContext,
      setProgressInputTokens,
      setProgressStartedAt,
      setTasksExpanded,
      setContextWarningSuppressed,
      setConfigInitialTab,
      setLoginInitialProvider,
      showErrorPanel,
      handleQuotaExhausted,
      showUnsupportedImageInput,
      flushDeferredPersistence,
      clearExitPending,
      promptHistoryIndexRef,
      pasteStoreRef,
    });
  onSubmitRef.current = onSubmit;
  runSubmittedTurnRef.current = runSubmittedTurn;
  requestBackgroundResumeRef.current = requestBackgroundResume;

  const panelChrome = panelChromeState({
    overlay,
    lowerPanelActive,
    bgTasksOpen,
    pendingInteractive,
    quotaPanelActive: quotaPanel !== null,
    errorPanelActive: errorPanel !== null,
    transcriptEmpty: transcript.length === 0,
    workflowDetailOpen,
  });
  const chrome = shellChromeState(panelChrome.shell);

  const { overlayLegacyProps, overlayStable, overlayDispatch } = useOverlayWiring({
    broker,
    session,
    agent,
    version,
    runtimeConfig,
    setRuntimeConfig,
    closeOverlay,
    configInitialTab,
    setConfigInitialTab,
    setLoginInitialProvider,
    loginInitialProvider,
    bgTasks,
    usageByProvider,
    offlineUsageByProvider,
    codexUsage,
    setCodexUsage,
    transcript,
    displayTranscript,
    rewindToTranscriptId,
    resumeSession,
    enqueuePendingChange,
    recordPanelCommit,
    workflowDetailTargetId,
    slashLifecycle,
  });
  return (
    <AppView
      state={state}
      runtimeConfig={runtimeConfig}
      version={version}
      greeting={greeting}
      sessionId={session.id}
      sessionCwd={session.cwd}
      aiTitle={aiTitle}
      busy={busy}
      btwMode={btwMode}
      chrome={chrome}
      panelChrome={panelChrome}
      progressStartedAt={progressStartedAt}
      progressTipIndex={progressTipIndex}
      turnVerb={turnVerb}
      spinnerMode={spinnerMode}
      thinkingStatus={thinkingStatus}
      tasksExpanded={tasksExpanded}
      retryStatus={retryStatus}
      logEpoch={logEpoch}
      displayTranscript={displayTranscript}
      liveEntries={liveEntries}
      transcript={transcript}
      queuedMessages={queuedMessages}
      onSubmit={onSubmit}
      promptText={promptText}
      setPromptText={setPromptText}
      popAllQueued={popAllQueued}
      promptHistoryNav={promptHistoryNav}
      panelFocused={panelFocused}
      bgPillFocused={bgPillFocused}
      pasteStore={pasteStoreRef.current}
      showUnsupportedImageInput={showUnsupportedImageInput}
      overlay={overlay}
      bgTasksOpen={bgTasksOpen}
      setConfigInitialTab={setConfigInitialTab}
      setLoginInitialProvider={setLoginInitialProvider}
      quotaPanel={quotaPanel}
      errorPanel={errorPanel}
      overlayOpenStack={overlayOpenStack}
      bgTasks={bgTasks}
      overlayStable={overlayStable}
      overlayDispatch={overlayDispatch}
      overlayLegacyProps={overlayLegacyProps}
      setBgTasksOpen={setBgTasksOpen}
      handleErrorAction={handleErrorAction}
      fallbackInputTokens={fallbackInputTokens}
      mainOutputTokens={mainOutputTokens}
      mainLastContext={mainLastContext}
      activeContextTotal={activeContextTotal}
      tokensWarning={usageWarning ?? contextBanner ?? undefined}
      autoCompactWarningPct={autoCompactWarningPct}
      clipboardImageActive={clipboardImageActive}
      activeGoalLabel={activeGoalLabel}
      exitPendingKey={exitPendingKey}
      remoteSyncStatus={remoteSyncStatus}
      panelStatusHint={panelStatusHint}
      panelAgents={panelAgents}
      workflowTasks={workflowTasks}
      panelSelectionValue={panelSelectionValue}
      viewingAgentId={viewingAgentId}
    />
  );
}
