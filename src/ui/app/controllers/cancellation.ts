import type { MutableRefObject } from "react";
import * as bgControllers from "@/engine/background/tasks/background-controllers.ts";
import type { Agent } from "@/engine/queue/index.ts";
import type { TurnGuard } from "@/engine/queue/runtime/turn/guard.ts";
import { nowIso, type Session } from "@/engine/session/index.ts";
import { hitMessage } from "@/engine/session/usage/format.ts";
import type { ErrorMeta } from "@/engine/transport/error-meta.ts";
import type { MacrotaskBatch } from "@/kernel/std/perf/macrotask-batch.ts";
import type { AutoClearDispatch } from "@/kernel/std/state/auto-clear-dispatch.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import type { ViewSlice } from "@/store/app-store/slices/view.ts";
import {
  dispatch,
  getQueueMessages,
  getTranscriptEntries,
  transcriptLiveStore,
} from "@/store/index.ts";
import { setLiveOutputTokens } from "@/store/live-tokens/index.ts";
import { getPromptText, setPromptText } from "@/store/prompt/index.ts";
import {
  compactRunningRef,
  freezeObserverRef,
  generatorActiveRef,
  runningRef,
  skillAbortRef,
  turnStartedAtRef,
} from "@/store/turn-run/index.ts";
import {
  compactTerminalRef,
  errorPanelActiveForTurnRef,
  quotaHandledForTurnRef,
} from "@/store/turn-status/index.ts";
import {
  currentAgentCallIdRef,
  currentTurnPromptRef,
  currentTurnUserIdRef,
  nextTranscriptId,
  turnHadVisibleOutputRef,
} from "@/store/turn-tracking/index.ts";
import {
  applyInterruptionResult,
  applyRestoreUnansweredResult,
  computeInterruptionResult,
  computeRestoreUnansweredResult,
} from "@/ui/app/dispatch/apply-interruption.ts";
import {
  type CancellationActions,
  type CancellationKey,
  type CancellationState,
  dispatchCancellation,
} from "@/ui/keybindings/cancel-ladder.ts";
import type { Overlay } from "@/ui/panels/registry.tsx";
import type { TranscriptSetters } from "@/ui/transcript/stream/setters.ts";

interface CancellationStageDeps {
  session: Session;
  agent: Agent;
  state: ReturnType<Broker["read"]>;
  promptText: string;
  overlay: Overlay;
  bgTasksOpen: boolean;
  setBgTasksOpen: (open: boolean) => void;
  bgPillFocused: boolean;
  lowerPanelActive: boolean;
  quotaPanel: ViewSlice["quotaPanel"];
  errorPanel: ViewSlice["errorPanel"];
  closeOverlay: () => void;
  exit: () => void;
  turnGuard: TurnGuard;
  requestBackgroundResumeRef: MutableRefObject<() => void>;
  transcriptBatch: MacrotaskBatch;
  setTranscript: TranscriptSetters["setTranscript"];
  setStreamingId: TranscriptSetters["setStreamingId"];
  setStreamingText: TranscriptSetters["setStreamingText"];
  setStreamingThinking: TranscriptSetters["setStreamingThinking"];
  setStreamingCommittedLen: TranscriptSetters["setStreamingCommittedLen"];
  setBusy: (value: boolean | ((prev: boolean) => boolean)) => void;
  setProgressStartedAt: (value: number | null | ((prev: number | null) => number | null)) => void;
  cancellationGraceDispatch: AutoClearDispatch;
  armExitPending: (keyName: "Ctrl-C" | "Ctrl-D") => void;
  clearExitPending: () => void;
  isExitArmed: (keyName: "Ctrl-C" | "Ctrl-D") => boolean;
  popAllQueued: () => string | null;
  resetRenderSurface: () => void;
}

interface CancellationStage {
  abortAllForkControllers: () => void;
  handleQuotaExhausted: (resetEpochMs: number | null) => void;
  showErrorPanel: (meta: ErrorMeta) => void;
  runCancellation: (key: CancellationKey, exitKeyName: "Ctrl-C" | "Ctrl-D") => void;
}

export function createCancellationStage(deps: CancellationStageDeps): CancellationStage {
  const {
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
  } = deps;

  const appendInterruptionFeedback = (showFeedback: boolean, conversationMarker = true): void => {
    transcriptBatch.flushNow();
    const live = transcriptLiveStore.getState();
    const result = computeInterruptionResult({
      entries: getTranscriptEntries(),
      partialText: live.streamingText,
      committedLen: live.committedLen,
      streamingId: live.streamingId,
      currentTurnUserId: currentTurnUserIdRef.current,
      showFeedback,
      conversationMarker,
      partialIdFallback: nextTranscriptId("a"),
      interruptId: nextTranscriptId("interrupt"),
      provider: state.provider,
      model: state.model,
      nowIso: nowIso(),
    });
    applyInterruptionResult(result, {
      session,
      setTranscript,
      setStreamingId,
      setStreamingText,
      setStreamingThinking,
      setStreamingCommittedLen,
    });
  };

  const abortAllForkControllers = (): void => {
    for (const callId of bgControllers.callIds()) {
      const controller = bgControllers.get(callId);
      if (controller && !controller.isBackgrounded()) controller.abort?.();
    }
  };

  const restoreUnansweredMessageToPrompt = (): boolean => {
    const entries = getTranscriptEntries();
    const result = computeRestoreUnansweredResult({
      turnHadVisibleOutput: turnHadVisibleOutputRef.current,
      streamingTextLength: transcriptLiveStore.getState().streamingText.length,
      entries,
      promptTextLength: promptText.length,
      queueLength: getQueueMessages().length,
      currentTurnUserId: currentTurnUserIdRef.current,
      currentTurnPrompt: currentTurnPromptRef.current,
    });
    const restored = applyRestoreUnansweredResult(result, {
      session,
      entries,
      setTranscript,
      setStreamingId,
      setStreamingText,
      setStreamingThinking,
      setStreamingCommittedLen,
      setPromptText,
      resetRenderSurface,
    });
    if (restored) {
      currentTurnPromptRef.current = null;
      currentTurnUserIdRef.current = null;
    }
    return restored;
  };

  const handleQuotaExhausted = (resetEpochMs: number | null): void => {
    if (quotaHandledForTurnRef.current) return;
    quotaHandledForTurnRef.current = true;
    const resetSeconds =
      resetEpochMs !== null && Number.isFinite(resetEpochMs) && resetEpochMs > 0
        ? Math.floor(resetEpochMs / 1000)
        : null;
    const text = hitMessage("limit", resetSeconds);
    const id = nextTranscriptId("quota");
    setTranscript((t) => {
      const last = t[t.length - 1];
      if (last?.kind === "quota_gutter" && last.text === text) return t;
      return [...t, { id, kind: "quota_gutter", text, isError: true }];
    });
    dispatch({ type: "view/setRetryStatus", status: null });
    dispatch({ type: "view/showQuota" });
    turnHadVisibleOutputRef.current = true;
    stageCancelTurn(false);
  };

  const showErrorPanel = (meta: ErrorMeta): void => {
    if (meta.errorClass === "context-window" || meta.retryable === false) {
      compactTerminalRef.current = true;
    }
    if (errorPanelActiveForTurnRef.current) {
      dispatch({ type: "view/bumpErrorAttempt", meta });
    } else {
      errorPanelActiveForTurnRef.current = true;
      dispatch({ type: "view/showErrorPanel", meta });
    }
  };

  const stageCancelTurn = (showFeedback: boolean): void => {
    // active before abort() = this is the first cancel for the live turn; a
    // second Esc finds the guard already idle (alreadyCancelling). abort() bumps
    // the generation so the live turn's finally settles to a no-op.
    const alreadyCancelling = !turnGuard.active;
    turnGuard.abort();
    agent.cancel();
    abortAllForkControllers();
    skillAbortRef.current?.abort("user-cancel");
    freezeObserverRef.current?.();
    const restored = showFeedback && restoreUnansweredMessageToPrompt();
    if (!alreadyCancelling && !compactRunningRef.current && !restored) {
      appendInterruptionFeedback(showFeedback, getQueueMessages().length === 0);
    }
    currentAgentCallIdRef.current = null;
    setLiveOutputTokens(0);
    setProgressStartedAt(null);
    setBusy(false);
    dispatch({ type: "view/setRetryStatus", status: null });
    const cancelledTurnStartedAt = turnStartedAtRef.current;
    cancellationGraceDispatch.arm({
      onTimeout: () => {
        if (!runningRef.current) return;
        if (turnStartedAtRef.current !== cancelledTurnStartedAt) return;
        runningRef.current = false;
        setBusy(false);
        setProgressStartedAt(null);
        setStreamingId(null);
        setStreamingText("");
        setStreamingThinking("");
        setStreamingCommittedLen(0);
        // The cancelled turn's own finally may be stalled (a stuck stream
        // teardown), stranding any queue behind it — the standing queue
        // processor (background-resume) picks it up; reserve/claim races there
        // make a double-promotion against a still-live turn impossible.
        requestBackgroundResumeRef.current();
      },
    });
  };

  const stageClosePanel = (): void => {
    if (quotaPanel !== null) {
      dispatch({ type: "view/hideQuota" });
      return;
    }
    if (errorPanel !== null) {
      dispatch({ type: "view/hideErrorPanel" });
      return;
    }
    if (bgPillFocused) {
      dispatch({ type: "view/setBgPillFocused", focused: false });
      return;
    }
    if (bgTasksOpen) {
      setBgTasksOpen(false);
      return;
    }
    if (overlay !== null) {
      closeOverlay();
      return;
    }
    if (lowerPanelActive) {
      setPromptText("");
    }
  };

  const runCancellation = (key: CancellationKey, exitKeyName: "Ctrl-C" | "Ctrl-D"): void => {
    const state: CancellationState = {
      panelOpen:
        overlay !== null ||
        bgTasksOpen ||
        bgPillFocused ||
        lowerPanelActive ||
        quotaPanel !== null ||
        errorPanel !== null,
      hasPromptText: promptText.length > 0,
      queueLength: getQueueMessages().length,
      turnRunning: generatorActiveRef.current,
      exitArmed: key === "ctrl-c" && isExitArmed(exitKeyName),
    };
    const actions: CancellationActions = {
      closePanel: () => {
        stageClosePanel();
        clearExitPending();
      },
      clearPromptText: () => {
        setPromptText("");
        clearExitPending();
      },
      restoreQueuedToPrompt: () => {
        const restored = popAllQueued();
        if (restored !== null) {
          const prev = getPromptText();
          setPromptText(prev.length > 0 ? `${restored}\n${prev}` : restored);
        }
        clearExitPending();
      },
      cancelTurn: () => {
        stageCancelTurn(true);
        clearExitPending();
      },
      armExitHint: () => armExitPending(exitKeyName),
      exit: () => {
        clearExitPending();
        // Worktree keep/remove prompt + tmux lifecycle before TUI exit.
        void (async () => {
          try {
            const { resolveWorktreeOnSessionExit } = await import(
              "@/engine/tools/builtins/worktree-exit.ts"
            );
            const result = await resolveWorktreeOnSessionExit(session);
            if (result.action === "cancel") return;
          } catch {
            // Best-effort — never block process exit on worktree cleanup failure.
          }
          exit();
        })();
      },
    };
    dispatchCancellation(key, state, actions);
  };

  return { abortAllForkControllers, handleQuotaExhausted, showErrorPanel, runCancellation };
}
