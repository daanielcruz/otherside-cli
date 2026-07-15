import {
  type ComponentProps,
  type Dispatch,
  type SetStateAction,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  pendingAgentSteers,
  subscribeAgentSteers,
} from "@/engine/background/subagents/fork/steering.ts";
import type { BackgroundTask } from "@/engine/background/tasks/background.ts";
import { getProviderConfig } from "@/engine/contract/registry.ts";
import { defaultEffortForModel, effortLevelsForModel, findModel } from "@/engine/model/catalog.ts";
import { autoRoutesNonVision, canSendNatively } from "@/engine/model/facts/capabilities-runtime.ts";
import type { ContextUsageSnapshot } from "@/engine/session/usage/snapshot.ts";
import type { ErrorActionId } from "@/engine/transport/error-meta.ts";
import { Box } from "@/ink";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { PasteStore } from "@/kernel/std/types/paste.ts";
import type { RemoteSyncStatus } from "@/kernel/std/types/remote-sync-status.ts";
import type { BrokerState } from "@/store/app-store/broker.ts";
import { dispatch, overlayStack, type QueuedMessage } from "@/store/index.ts";
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
import { Prompt } from "@/ui/input/prompt.tsx";
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
type StatuslineProps = ComponentProps<typeof Statusline>;
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
  tokensWarning: StatuslineProps["tokensWarning"];
  autoCompactWarningPct: StatuslineProps["autoCompactRemainingPct"];
  clipboardImageActive: boolean;
  activeGoalLabel: string | undefined;
  exitPendingKey: string | null;
  remoteSyncStatus: RemoteSyncStatus;
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
    tokensWarning,
    autoCompactWarningPct,
    clipboardImageActive,
    activeGoalLabel,
    exitPendingKey,
    remoteSyncStatus,
    panelStatusHint,
    panelAgents,
    workflowTasks,
    panelSelectionValue,
    viewingAgentId,
  } = props;

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
  const progressNode = panelChrome.shell.overlayActive ? null : viewingTask !== undefined ? (
    // The agent view runs the same spinner surface as the main loop, fed by
    // the viewed task: its own elapsed clock and its token count.
    viewingAgentLlmActive ? (
      <OffscreenFreeze>
        <ThinkingBlock
          key={viewingTask.id}
          active={true}
          startedAt={viewingTask.startedAt}
          tipIndex={progressTipIndex}
          verb="Running"
          tokenCount={viewingTask.inputTokens + viewingTask.outputTokens}
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
                queueHint={visibleBusy && visibleQueuedMessages.length > 0}
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
                emptyDoubleEscapeEnabled={viewingTask === undefined}
                onEmptyDoubleEscape={openRewindFromEmptyPrompt}
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
                tokensWarning={viewingTask === undefined ? tokensWarning : undefined}
                autoCompactRemainingPct={
                  viewingTask === undefined ? autoCompactWarningPct : undefined
                }
                goalLabel={
                  viewingTask === undefined && !clipboardImageActive ? activeGoalLabel : undefined
                }
              />
              <StatusBar
                state={visibleState}
                busy={visibleBusy}
                exitHint={
                  viewingTask === undefined && exitPendingKey !== null
                    ? `Press ${exitPendingKey} again to exit`
                    : undefined
                }
                bgTaskLabel={bgPillLabelFor(bgTasks.filter((t) => t.kind === "shell"))}
                bgTaskFocused={bgPillFocused}
                remoteSyncStatus={remoteSyncStatus}
                clipboardHint={clipboardImageActive}
                goalLabel={clipboardImageActive ? activeGoalLabel : undefined}
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
