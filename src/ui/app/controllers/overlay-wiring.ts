import { useCallback, useMemo } from "react";
import type { PendingChange } from "@/commands/index.ts";
import { createDesignController, type DesignControllerDeps } from "@/design/controller.ts";
import type { BackgroundTask } from "@/engine/background/tasks/background.ts";
import type { CodexUsage } from "@/engine/providers/codex/usage.ts";
import type { Agent } from "@/engine/queue/index.ts";
import type { Session } from "@/engine/session/index.ts";
import type { ResumeSessionFn } from "@/engine/session/resume.ts";
import type { RewindToTranscriptIdFn } from "@/engine/session/rewind.ts";
import type { UsageByProvider } from "@/engine/session/usage/provider.ts";
import { discardFrameBaseline } from "@/ink";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import type { ViewSlice } from "@/store/app-store/slices/view.ts";
import { dispatch, overlayStack } from "@/store/index.ts";
import { runningRef } from "@/store/turn-run/index.ts";
import type { OverlayDispatchValue, OverlayStableValue } from "@/ui/panels/context";
import type { OverlayName, OverlayRegistryProps } from "@/ui/panels/registry.tsx";
import type { TranscriptEntry } from "@/ui/transcript/types";

interface OverlayWiringDeps {
  broker: Broker;
  session: Session;
  agent: Agent;
  version: string;
  runtimeConfig: UserConfig;
  setRuntimeConfig: (config: UserConfig) => void;
  closeOverlay: () => void;
  configInitialTab: ViewSlice["configInitialTab"];
  setConfigInitialTab: (tab: ViewSlice["configInitialTab"]) => void;
  setLoginInitialProvider: (provider: ProviderId | undefined) => void;
  loginInitialProvider: ProviderId | undefined;
  bgTasks: BackgroundTask[];
  usageByProvider: UsageByProvider;
  offlineUsageByProvider: UsageByProvider;
  codexUsage: CodexUsage | null;
  setCodexUsage: (usage: CodexUsage | null) => void;
  transcript: readonly TranscriptEntry[];
  displayTranscript: readonly TranscriptEntry[];
  rewindToTranscriptId: RewindToTranscriptIdFn;
  resumeSession: ResumeSessionFn;
  enqueuePendingChange: (change: PendingChange, label: string) => void;
  recordPanelCommit: (commandName: string, feedback: string) => void;
  workflowDetailTargetId: string | null | undefined;
  slashLifecycle: { onSessionFinalize: DesignControllerDeps["onFinalize"] };
}

interface OverlayWiringResult {
  overlayLegacyProps: OverlayRegistryProps;
  overlayStable: OverlayStableValue;
  overlayDispatch: OverlayDispatchValue;
}

export function useOverlayWiring(deps: OverlayWiringDeps): OverlayWiringResult {
  const {
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
  } = deps;

  const handleConfigChange = useCallback(
    (next: UserConfig): void => {
      setRuntimeConfig(next);
      agent.updateConfig(next);
    },
    [agent],
  );
  const openLoginOverlay = useCallback((provider: ProviderId | undefined): void => {
    setConfigInitialTab(undefined);
    setLoginInitialProvider(provider);
    overlayStack.open("login");
  }, []);
  const openOverlayByName = useCallback((name: OverlayName): void => {
    overlayStack.open(name);
  }, []);
  const rewindByIdMode = useCallback(
    (id: string, mode?: unknown): void => {
      const rewindMode =
        mode === "conversation" || mode === "code" || mode === "both" ? mode : undefined;
      rewindToTranscriptId(id, rewindMode);
    },
    [rewindToTranscriptId],
  );
  const isTurnRunningProbe = useCallback((): boolean => runningRef.current, []);
  const onOpenModel = useCallback((): void => {
    setLoginInitialProvider(undefined);
    overlayStack.open("model");
  }, []);
  const onOpenLogin = useCallback((provider: ProviderId | undefined): void => {
    setConfigInitialTab(undefined);
    setLoginInitialProvider(provider);
    overlayStack.open("login");
  }, []);
  const onWorkflowDetailOpenChange = useCallback((open: boolean): void => {
    dispatch({ type: "view/setWorkflowDetailOpen", open });
  }, []);
  const designController = useMemo(
    () =>
      createDesignController({
        broker,
        session,
        agent,
        version,
        onFinalize: slashLifecycle.onSessionFinalize,
      }),
    [broker, session, agent, version, slashLifecycle],
  );
  const overlayLegacyProps = useMemo<OverlayRegistryProps>(
    () => ({
      broker,
      session,
      designController,
      config: runtimeConfig,
      version,
      onClose: closeOverlay,
      onOpenModel,
      onOpenLogin,
      loginInitialProvider,
      tasks: bgTasks,
      usageByProvider,
      offlineUsageByProvider,
      codexUsage,
      onCodexUsage: setCodexUsage,
      configInitialTab,
      onConfigChange: handleConfigChange,
      transcript: displayTranscript,
      transcriptFull: transcript,
      onRewind: rewindToTranscriptId,
      onResumeSession: resumeSession,
      isTurnRunning: isTurnRunningProbe,
      enqueueChange: enqueuePendingChange,
      workflowDetailTargetId,
      onWorkflowDetailOpenChange,
    }),
    [
      broker,
      session,
      designController,
      runtimeConfig,
      version,
      closeOverlay,
      onOpenModel,
      onOpenLogin,
      loginInitialProvider,
      bgTasks,
      usageByProvider,
      offlineUsageByProvider,
      codexUsage,
      configInitialTab,
      handleConfigChange,
      displayTranscript,
      transcript,
      rewindToTranscriptId,
      resumeSession,
      isTurnRunningProbe,
      enqueuePendingChange,
      workflowDetailTargetId,
      onWorkflowDetailOpenChange,
      setCodexUsage,
    ],
  );
  const overlayStable: OverlayStableValue = useMemo(
    () => ({
      broker,
      session,
      config: runtimeConfig,
      version,
      tasks: bgTasks,
      usageByProvider,
      offlineUsageByProvider,
      codexUsage,
    }),
    [
      broker,
      session,
      runtimeConfig,
      version,
      bgTasks,
      usageByProvider,
      offlineUsageByProvider,
      codexUsage,
    ],
  );
  const overlayDispatch: OverlayDispatchValue = useMemo(
    () => ({
      closeOverlay,
      invalidatePrevFrame: discardFrameBaseline,
      openOverlay: openOverlayByName,
      onConfigChange: handleConfigChange,
      onOpenLogin: openLoginOverlay,
      onCodexUsage: setCodexUsage,
      enqueueChange: enqueuePendingChange,
      onResumeSession: resumeSession,
      onRewind: rewindByIdMode,
      isTurnRunning: isTurnRunningProbe,
      recordPanelCommit,
    }),
    [
      closeOverlay,
      openOverlayByName,
      handleConfigChange,
      openLoginOverlay,
      enqueuePendingChange,
      resumeSession,
      rewindByIdMode,
      isTurnRunningProbe,
      setCodexUsage,
      recordPanelCommit,
    ],
  );

  return { overlayLegacyProps, overlayStable, overlayDispatch };
}
