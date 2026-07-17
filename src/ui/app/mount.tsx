import {
  type ComponentProps,
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  pendingAgentSteers,
  subscribeAgentSteers,
} from "@/engine/background/subagents/fork/steering.ts";
import type { BackgroundTask } from "@/engine/background/tasks/background.ts";
import { aggregateSubtreeProgress } from "@/engine/background/tasks/progress.ts";
import { getProviderConfig } from "@/engine/contract/registry.ts";
import { defaultEffortForModel, effortLevelsForModel, findModel } from "@/engine/model/catalog.ts";
import { autoRoutesNonVision, canSendNatively } from "@/engine/model/facts/capabilities-runtime.ts";
import type { ContextUsageSnapshot } from "@/engine/session/usage/snapshot.ts";
import type { ErrorActionId } from "@/engine/transport/error-meta.ts";
import { resolveVoiceProvider } from "@/engine/voice/index.ts";
import { Box } from "@/ink";
import { effectiveOrchestrationMode, type UserConfig } from "@/kernel/config/config.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { createAutoClearDispatch } from "@/kernel/std/state/auto-clear-dispatch.ts";
import type { PasteStore } from "@/kernel/std/types/paste.ts";
import type { BrokerState } from "@/store/app-store/broker.ts";
import { dispatch, overlayStack, type QueuedMessage } from "@/store/index.ts";
import { usePromptSelector } from "@/store/prompt/index.ts";
import { runningRef } from "@/store/turn-run/index.ts";
import type { createPromptHistoryNav } from "@/ui/app/drain/prompt-history-nav.ts";
import { bgPillLabelFor, effortBadge, thinkingSuffixFor } from "@/ui/app/status-text.ts";
import { ChromeShell } from "@/ui/chrome/layout/chrome-shell.tsx";
import { LowerPanelSlot } from "@/ui/chrome/layout/lower-panel-slot.tsx";
import type { shellChromeState } from "@/ui/chrome/layout/shell.tsx";
import type { panelChromeState } from "@/ui/chrome/overlay.ts";
import { QueueArea } from "@/ui/chrome/queue-area.tsx";
import { RunningAgentsPanel } from "@/ui/chrome/running-agents-panel.tsx";
import { StatusBar } from "@/ui/chrome/status/bar.tsx";
import { Statusline } from "@/ui/chrome/status/line.tsx";
import { TerminalTitle } from "@/ui/chrome/terminal-title.tsx";
import { useQueuedEditHint } from "@/ui/hooks/use-queued-edit-hint.ts";
import { Prompt, type VoiceChromeState } from "@/ui/input/prompt.tsx";
import { KeybindingSetup } from "@/ui/keybindings/keybinding-setup.tsx";
import type { Overlay } from "@/ui/panels/registry.tsx";
import { BtwBlock } from "@/ui/transcript/blocks/btw.tsx";
import { ProgressBlock } from "@/ui/transcript/blocks/progress.tsx";
import { ThinkingBlock } from "@/ui/transcript/blocks/thinking.tsx";
import { OffscreenFreeze } from "@/ui/transcript/stream/offscreen-freeze.tsx";
import { useViewingAgentTranscript } from "@/ui/transcript/stream/poll.ts";
import { TranscriptView } from "@/ui/transcript/transcript-view.tsx";
import type { TranscriptEntry } from "@/ui/transcript/types";

type LowerPanelProps = ComponentProps<typeof LowerPanelSlot>;
type StatusBarProps = ComponentProps<typeof StatusBar>;
type RunningAgentsPanelProps = ComponentProps<typeof RunningAgentsPanel>;
type TranscriptViewProps = ComponentProps<typeof TranscriptView>;
type ProgressBlockProps = ComponentProps<typeof ProgressBlock>;

const EMPTY_AGENT_STEERS = [] as const;

export interface AppViewProps {
  state: BrokerState;
  runtimeConfig: UserConfig;
  version: string;
  greeting: string | undefined;
  sessionId: string;
  sessionCwd: string;
  aiTitle: string | null;
  busy: boolean;
  btwMode: boolean;
  chrome: ReturnType<typeof shellChromeState>;
  panelChrome: ReturnType<typeof panelChromeState>;
  progressStartedAt: ProgressBlockProps["startedAt"];
  progressTipIndex: ProgressBlockProps["tipIndex"];
  turnVerb: ProgressBlockProps["verb"];
  spinnerMode: ProgressBlockProps["spinnerMode"];
  thinkingStatus: ProgressBlockProps["thinkingStatus"];
  tasksExpanded: ProgressBlockProps["tasksExpanded"];
  retryStatus: ProgressBlockProps["retryStatus"];
  logEpoch: TranscriptViewProps["logEpoch"];
  displayTranscript: TranscriptViewProps["transcript"];
  liveEntries: TranscriptViewProps["liveEntries"];
  transcript: readonly TranscriptEntry[];
  queuedMessages: readonly QueuedMessage[];
  onSubmit: (text: string) => Promise<void>;
  promptText: string;
  setPromptText: (text: string) => void;
  popAllQueued: () => string | null;
  promptHistoryNav: ReturnType<typeof createPromptHistoryNav>;
  panelFocused: boolean;
  bgPillFocused: boolean;
  pasteStore: PasteStore;
  showUnsupportedImageInput: (providerId: ProviderId) => void;
  overlay: Overlay;
  bgTasksOpen: boolean;
  setConfigInitialTab: (tab: "details" | "config" | undefined) => void;
  setLoginInitialProvider: Dispatch<SetStateAction<ProviderId | undefined>>;
  quotaPanel: LowerPanelProps["quotaPanel"];
  errorPanel: LowerPanelProps["errorPanel"];
  overlayOpenStack: LowerPanelProps["overlayOpenStack"];
  bgTasks: LowerPanelProps["bgTasks"];
  overlayStable: LowerPanelProps["overlayStable"];
  overlayDispatch: LowerPanelProps["overlayDispatch"];
  overlayLegacyProps: LowerPanelProps["overlayLegacyProps"];
  setBgTasksOpen: Dispatch<SetStateAction<boolean>>;
  handleErrorAction: (id: ErrorActionId) => void;
  fallbackInputTokens: number;
  mainOutputTokens: number;
  mainLastContext: ContextUsageSnapshot;
  activeContextTotal: number;
  exitPendingKey: string | null;
  panelStatusHint: StatusBarProps["panelHint"];
  panelAgents: RunningAgentsPanelProps["agents"];
  workflowTasks: RunningAgentsPanelProps["workflows"];
  panelSelectionValue: RunningAgentsPanelProps["selection"];
  viewingAgentId: string | null;
}

export function projectThreadView(input: {
  state: BrokerState;
  task: BackgroundTask | undefined;
  busy: boolean;
  inputTokens: number;
  outputTokens: number;
  contextTotal: number;
}): {
  state: BrokerState;
  busy: boolean;
  inputTokens: number;
  outputTokens: number;
  contextTotal: number;
} {
  if (input.task === undefined) {
    return {
      state: input.state,
      busy: input.busy,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      contextTotal: input.contextTotal,
    };
  }
  const model = input.task.model ?? input.state.model;
  const provider = input.task.provider ?? findModel(model)?.provider ?? input.state.provider;
  return {
    state: {
      ...input.state,
      provider,
      model,
      effort: input.task.effort ?? defaultEffortForModel(model, provider),
      ultracode: false,
    },
    busy: input.task.status === "running",
    inputTokens: input.task.inputTokens,
    outputTokens: input.task.outputTokens,
    contextTotal: input.task.inputTokens + input.task.outputTokens,
  };
}

// Provider-tree assembly: the presentational shell for the app. All reactive
// state, refs, and turn logic live in app.tsx and its store slices; this
// component only maps already-derived values onto the chrome/transcript/prompt
// tree so the render surface stays isolated from orchestration.
export function AppView(props: AppViewProps): React.JSX.Element {
  const {
    state,
    runtimeConfig,
    version,
    greeting,
    sessionId,
    sessionCwd,
    aiTitle,
    busy,
    btwMode,
    chrome,
    panelChrome,
    progressStartedAt,
    progressTipIndex,
    turnVerb,
    spinnerMode,
    thinkingStatus,
    tasksExpanded,
    retryStatus,
    logEpoch,
    displayTranscript,
    liveEntries,
    transcript,
    queuedMessages,
    onSubmit,
    promptText,
    setPromptText,
    popAllQueued,
    promptHistoryNav,
    panelFocused,
    bgPillFocused,
    pasteStore,
    showUnsupportedImageInput,
    overlay,
    bgTasksOpen,
    setConfigInitialTab,
    setLoginInitialProvider,
    quotaPanel,
    errorPanel,
    overlayOpenStack,
    bgTasks,
    overlayStable,
    overlayDispatch,
    overlayLegacyProps,
    setBgTasksOpen,
    handleErrorAction,
    fallbackInputTokens,
    mainOutputTokens,
    mainLastContext,
    activeContextTotal,
    exitPendingKey,
    panelStatusHint,
    panelAgents,
    workflowTasks,
    panelSelectionValue,
    viewingAgentId,
  } = props;

  // Voice chrome still notifies the prompt; display lives in RightStatusRegion.
  const onVoiceStateChange = useCallback((_next: VoiceChromeState) => {}, []);

  const showIntro = chrome.showWelcome;
  const viewingTask =
    viewingAgentId !== null ? bgTasks.find((t) => t.id === viewingAgentId) : undefined;
  const viewingForkId = viewingTask?.kind === "agent" ? viewingTask.forkId : undefined;
  const viewedAgentSteers = useSyncExternalStore(
    subscribeAgentSteers,
    () => (viewingForkId === undefined ? EMPTY_AGENT_STEERS : pendingAgentSteers(viewingForkId)),
    () => EMPTY_AGENT_STEERS,
  );
  const visibleQueuedMessages = useMemo<readonly QueuedMessage[]>(
    () =>
      viewingTask === undefined
        ? queuedMessages
        : viewedAgentSteers.map((message, index) => ({
            id: message.queueId ?? `${viewingForkId}-${index}`,
            text: message.text,
            expanded: message.text,
            blocks: message.blocks,
          })),
    [queuedMessages, viewedAgentSteers, viewingForkId, viewingTask],
  );
  const { entries: viewingAgentEntries, llmActive: viewingAgentLlmActive } =
    useViewingAgentTranscript({
      task: viewingTask,
      sessionId,
      cwd: sessionCwd,
    });
  const {
    state: visibleState,
    busy: visibleBusy,
    inputTokens: visibleInputTokens,
    outputTokens: visibleOutputTokens,
    contextTotal: visibleContextTotal,
  } = projectThreadView({
    state,
    task: viewingTask,
    busy,
    inputTokens: fallbackInputTokens,
    outputTokens: mainOutputTokens,
    contextTotal: activeContextTotal,
  });
  const queuedEditHint = useQueuedEditHint(visibleBusy && visibleQueuedMessages.length > 0);
  // The view's divider pill always identifies WHAT is running — agent type,
  // model and effort ("Verifier - GPT-5.6 Sol Max"). The spawn description
  // already lives in the agents panel row and must not displace the identity.
  const agentPill = viewingTask
    ? [
        viewingTask.agentName,
        viewingTask.model !== undefined
          ? `- ${findModel(viewingTask.model)?.displayName ?? viewingTask.model}`
          : undefined,
        viewingTask.effort !== undefined ? effortPillLabel(viewingTask.effort) : undefined,
      ]
        .filter(Boolean)
        .join(" ")
    : undefined;
  // While viewing an agent, an empty prompt shows who the message goes to.
  const agentMessagePlaceholder = viewingTask
    ? agentPlaceholderText(viewingTask.agentName)
    : undefined;
  const [editorHint, setEditorHint] = useState<string | null>(null);
  const editorHintDispatch = useMemo(() => createAutoClearDispatch({ holdMs: 5000 }), []);
  useEffect(() => {
    return () => editorHintDispatch.clear();
  }, [editorHintDispatch]);
  const showEditorHint = (text: string): void => {
    setEditorHint(text);
    editorHintDispatch.arm({ key: text, onTimeout: () => setEditorHint(null) });
  };
  const promptSearch = usePromptSelector((s) => s.search);
  // Exit confirmation outranks editor hints; the agent view shows neither.
  const exitConfirmHint =
    exitPendingKey !== null ? `Press ${exitPendingKey} again to exit` : undefined;
  const statusHint =
    viewingTask === undefined ? (exitConfirmHint ?? editorHint ?? undefined) : undefined;
  const openRewindFromEmptyPrompt = (): void => {
    if (overlay !== null || bgTasksOpen || runningRef.current) return;
    setConfigInitialTab(undefined);
    setLoginInitialProvider(undefined);
    overlayStack.open("rewind");
  };

  // OffscreenFreeze: a giant queue/prompt block below can push this row past
  // the fold; its per-second verb/elapsed/token updates are state-driven, and
  // each update above the fold costs a full terminal reset.
  // A fullscreen overlay owns every row; the per-second progress repaints
  // underneath it tear the overlay frame apart — suppress while it is open.
  // Agent view keeps the spinner for the whole running lifetime — tool_use-only
  // turns still need a live token/elapsed signal (llmActive alone goes false
  // while tools run). Tokens include the viewed agent's descendant subtree.
  const viewingAgentRunning = viewingTask?.status === "running";
  const viewingAgentTokenCount =
    viewingTask === undefined ? 0 : aggregateSubtreeProgress(viewingTask.id, bgTasks).tokenCount;
  const progressNode = panelChrome.shell.overlayActive ? null : viewingTask !== undefined ? (
    viewingAgentRunning ? (
      <OffscreenFreeze>
        <ThinkingBlock
          key={viewingTask.id}
          active={true}
          startedAt={viewingTask.startedAt}
          tipIndex={progressTipIndex}
          verb={viewingAgentLlmActive ? "Running" : "Working"}
          tokenCount={viewingAgentTokenCount}
          includeGlobalTokenCount={false}
          spinnerMode="responding"
          showTip={runtimeConfig.showTips ?? true}
          retryStatus={null}
        />
      </OffscreenFreeze>
    ) : null
  ) : (
    <OffscreenFreeze>
      {btwMode ? (
        <BtwBlock active={true} />
      ) : (
        <ProgressBlock
          active={busy}
          startedAt={progressStartedAt}
          tipIndex={progressTipIndex}
          verb={turnVerb}
          spinnerMode={spinnerMode}
          thinkingStatus={thinkingStatus}
          thinkingSuffix={thinkingSuffixFor(state.provider, state.effort)}
          showTip={runtimeConfig.showTips ?? true}
          tasksExpanded={tasksExpanded}
          retryStatus={retryStatus}
        />
      )}
    </OffscreenFreeze>
  );

  return (
    <KeybindingSetup>
      <TerminalTitle title={aiTitle} />
      <ChromeShell
        welcome={null}
        displacesTranscript={chrome.displacesTranscript}
        log={
          <TranscriptView
            viewingTask={viewingTask}
            viewingAgentEntries={viewingAgentEntries}
            logEpoch={logEpoch}
            transcript={displayTranscript}
            liveEntries={liveEntries}
            showIntro={showIntro}
            version={version}
            greeting={greeting}
            providerShortKey={
              getProviderConfig(visibleState.provider)?.provider.shortKey ?? visibleState.provider
            }
            currentModel={visibleState.model}
          />
        }
        progress={progressNode}
        queue={
          <QueueArea
            messages={visibleQueuedMessages}
            active={visibleBusy || visibleQueuedMessages.length > 0}
          />
        }
        prompt={
          chrome.showPrompt ? (
            <Box position="relative" width="100%" flexDirection="column">
              <Prompt
                onSubmit={onSubmit}
                value={promptText}
                onChange={setPromptText}
                queueHint={queuedEditHint}
                fastModeActive={
                  getProviderConfig(visibleState.provider)?.featureFlags?.fastMode === true &&
                  visibleState.fastMode
                }
                agentPill={agentPill}
                effortLevel={effortBadge({
                  ultracode: !!visibleState.ultracode,
                  effort: visibleState.effort,
                  hasEffort:
                    effortLevelsForModel(visibleState.model, visibleState.provider).length > 0,
                })}
                queuedRestoreEnabled={viewingTask === undefined}
                onRestoreQueued={popAllQueued}
                onHistoryPrev={promptHistoryNav.restorePrev}
                onHistoryNext={promptHistoryNav.restoreNext}
                navLocked={panelChrome.promptLocked || panelFocused || bgPillFocused}
                arrowNavigationLocked={viewingAgentId !== null}
                pasteStore={pasteStore}
                imagePasteEnabled={
                  canSendNatively(visibleState.provider, visibleState.model) ||
                  autoRoutesNonVision(visibleState.provider) ||
                  Boolean(runtimeConfig.imageParserProvider)
                }
                onUnsupportedImagePaste={() => showUnsupportedImageInput(visibleState.provider)}
                voiceProvider={resolveVoiceProvider(
                  runtimeConfig.voiceProvider,
                  visibleState.provider,
                )}
                language={runtimeConfig.language}
                onVoiceStateChange={onVoiceStateChange}
                emptyDoubleEscapeEnabled={viewingTask === undefined}
                onEmptyDoubleEscape={openRewindFromEmptyPrompt}
                placeholder={agentMessagePlaceholder}
                onEditorHint={showEditorHint}
                historyEntries={promptHistoryNav.entries}
              />
            </Box>
          ) : null
        }
        panel={
          <LowerPanelSlot
            quotaPanel={quotaPanel}
            errorPanel={errorPanel}
            bgTasksOpen={bgTasksOpen}
            overlayOpenStack={overlayOpenStack}
            bgTasks={bgTasks}
            overlayStable={overlayStable}
            overlayDispatch={overlayDispatch}
            overlayLegacyProps={overlayLegacyProps}
            onOpenModel={() => {
              dispatch({ type: "view/hideQuota" });
              setLoginInitialProvider(undefined);
              overlayStack.open("model");
            }}
            onCloseBgTasks={() => setBgTasksOpen(false)}
            onErrorAction={handleErrorAction}
          />
        }
        footer={
          chrome.showFooter ? (
            <>
              <Statusline
                state={visibleState}
                sessionId={sessionId}
                version={version}
                config={runtimeConfig.statusline}
                orchestrationMode={effectiveOrchestrationMode(runtimeConfig)}
                cwd={viewingTask?.cwd ?? sessionCwd}
                refreshKey={`${viewingTask?.id ?? "main"}:${sessionCwd}:${transcript.length}:${liveEntries.length}:${visibleQueuedMessages.length}:${visibleBusy}:${visibleInputTokens}:${visibleOutputTokens}`}
                inputTokens={visibleInputTokens}
                outputTokens={visibleOutputTokens}
                cacheCreationInputTokens={
                  viewingTask === undefined ? mainLastContext.cacheCreationInputTokens : 0
                }
                cacheReadInputTokens={
                  viewingTask === undefined ? mainLastContext.cacheReadInputTokens : 0
                }
                totalTokens={visibleContextTotal}
              />
              <StatusBar
                state={visibleState}
                busy={visibleBusy}
                historySearch={promptSearch ?? undefined}
                exitHint={statusHint}
                bgTaskLabel={bgPillLabelFor(bgTasks.filter((t) => t.kind === "shell"))}
                bgTaskFocused={bgPillFocused}
                panelHint={panelStatusHint}
              />
              <RunningAgentsPanel
                agents={panelAgents}
                workflows={workflowTasks}
                selection={panelSelectionValue}
                focusInPanel={panelFocused}
                viewingAgentId={viewingAgentId ?? undefined}
                mainLlmBusy={busy}
              />
              <Box height={1} />
            </>
          ) : null
        }
        itemCount={transcript.length + liveEntries.length}
      />
    </KeybindingSetup>
  );
}

function effortPillLabel(effort: string): string {
  if (effort === "xhigh") return "xHigh";
  if (effort.length === 0) return effort;
  return effort[0]!.toUpperCase() + effort.slice(1);
}

const AGENT_PLACEHOLDER_NAME_MAX = 20;

function agentPlaceholderText(agentName: string): string {
  const displayName =
    agentName.length > AGENT_PLACEHOLDER_NAME_MAX
      ? `${agentName.slice(0, AGENT_PLACEHOLDER_NAME_MAX - 3)}...`
      : agentName;
  return `Message @${displayName}…`;
}
