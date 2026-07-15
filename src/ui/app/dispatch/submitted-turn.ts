import { autoRoutesNonVision, canSendNatively } from "@/engine/model/facts/capabilities-runtime.ts";
import { extractBodyMessage } from "@/engine/providers/_shared/retry.ts";
import { extractPastedImages, resolveNonVisionImageBlocks } from "@/engine/queue/turn/input.ts";
import { runSessionTurn } from "@/engine/queue/turn/run-session.ts";
import { makeTuiTurnObserver } from "@/engine/queue/turn/tui-observer.ts";
import {
  appendAiTitle,
  appendRecord,
  generateSessionTitle,
  nowIso,
  revokeLastUnansweredUserMessage,
  type UserMessageRecord,
} from "@/engine/session/index.ts";
import { mergeContextUsageSnapshot } from "@/engine/session/usage/snapshot.ts";
import { classifyError, classifyProviderError } from "@/engine/transport/errors.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
import { setActiveRewindTurn } from "@/kernel/storage/file-history.ts";
import { emitPushEvent } from "@/remote/index.ts";
import {
  dispatch,
  getQueueMessages,
  sessionTitleActions,
  sessionTitleStore,
} from "@/store/index.ts";
import { setLiveOutputTokens } from "@/store/live-tokens/index.ts";
import {
  freezeObserverRef,
  generatorActiveRef,
  turnSeedRef,
  turnStartedAtRef,
} from "@/store/turn-run/index.ts";
import {
  compactTerminalRef,
  errorPanelActiveForTurnRef,
  pendingErrorRevokeRef,
  quotaHandledForTurnRef,
} from "@/store/turn-status/index.ts";
import {
  activeToolsRef,
  agentModelByCallIdRef,
  currentAgentCallIdRef,
  currentTurnPromptRef,
  currentTurnUserIdRef,
  forkActionRef,
  forkToCallIdRef,
  nextTranscriptId,
  turnHadVisibleOutputRef,
} from "@/store/turn-tracking/index.ts";
import { createPromoteContinuation } from "@/ui/app/dispatch/promote-continuation.ts";
import type { DispatchLoop, DispatchLoopDeps } from "@/ui/app/dispatch/types.ts";
import {
  formatTurnDuration,
  pickVerbForTurn,
  TURN_COMPLETION_VERB,
} from "@/ui/chrome/progress/index.ts";
import { expandToContentBlocks } from "@/ui/input/paste/references.ts";
import {
  askAnswerEntry,
  taskNoticeTextFromNotification,
} from "@/ui/transcript/records/entry-builders.ts";
import { SILENT_TOOL_NAMES } from "@/ui/transcript/records/from-records.ts";
import { estimateTokens } from "@/ui/transcript/stats.ts";

function applyAdditionalContext(
  blocks: ContentBlock[],
  additionalContext: string[],
): ContentBlock[] {
  if (additionalContext.length === 0) return blocks;
  return [
    {
      type: "text",
      text: additionalContext
        .map((ctx) => `<system-reminder>${ctx}</system-reminder>`)
        .join("\n\n"),
    },
    ...blocks,
  ];
}

function formatTurnError(err: unknown): string {
  if (!err || typeof err !== "object") {
    return err instanceof Error ? err.message : String(err);
  }
  const obj = err as { status?: unknown; body?: unknown; message?: unknown };
  const status = typeof obj.status === "number" ? obj.status : null;
  const body = typeof obj.body === "string" ? obj.body : "";
  const parsed = body ? extractBodyMessage(body) : null;
  const message = parsed ?? (typeof obj.message === "string" ? obj.message : String(err));
  return status !== null ? `HTTP ${status}: ${message}` : message;
}

export function createRunSubmittedTurn(
  deps: DispatchLoopDeps,
  wiring: { handleSlash: (rawText: string) => boolean; requestBackgroundResume: () => void },
): DispatchLoop["runSubmittedTurn"] {
  const {
    session,
    broker,
    agent,
    runtimeConfig,
    transcript,
    turnGuard,
    turnLifecycle,
    recordProviderUsage,
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
    showErrorPanel,
    handleQuotaExhausted,
    showUnsupportedImageInput,
    flushDeferredPersistence,
    pasteStoreRef,
  } = deps;
  const { handleSlash, requestBackgroundResume } = wiring;

  const maybeGenerateSessionTitle = (text: string): void => {
    if (sessionTitleStore.getState().attempted) return;
    sessionTitleActions.setAttempted(true);
    const forSessionId = session.id;
    const state = broker.read();
    void generateSessionTitle(
      {
        provider: state.provider,
        model: state.model,
        effort: state.effort,
        fastMode: state.fastMode,
        permissionMode: state.permissionMode,
        sessionId: forSessionId,
        cwd: session.cwd,
      },
      text,
    ).then((title) => {
      if (session.id !== forSessionId) return;
      if (title === null) {
        sessionTitleActions.setAttempted(false);
        return;
      }
      sessionTitleActions.setTitle(title);
      void appendAiTitle(session.cwd, forSessionId, title);
    });
  };

  const runSubmittedTurn = async (
    text: string,
    opts?: {
      suppressUserTranscript?: boolean;
      additionalContext?: string[];
      blocks?: ContentBlock[];
      isRemote?: boolean;
      restoreEntryId?: string;
    },
  ): Promise<void> => {
    // Claim the guard before anything else — including the await right below and
    // the session/transcript mutation further down — so a second concurrent
    // dispatch (another wake source racing this one) is rejected here, before it
    // touches shared state, rather than discovering the loss deep inside the try
    // block below. A no-op when a caller (queue promotion, the background-resume
    // wake) already reserved on this dispatch's behalf.
    if (!turnGuard.claim()) return;
    // Between here and begin() below, any throw or early return must release
    // the claim (cancelReservation), or the guard sticks in `dispatching` and
    // the wake driver's reserve() stays blocked until the next user dispatch.
    await flushDeferredPersistence().catch((err) => {
      turnGuard.cancelReservation();
      throw err;
    });
    void import("@/remote/index.ts").then((r) => r.setSessionStatus("streaming")).catch(() => {});
    dispatch({ type: "view/setRetryStatus", status: null });
    const turnState = broker.read();
    const isResume = text.length === 0;
    if (isResume) {
      const pendingInjections = agent.injections.peek();
      for (const injection of pendingInjections) {
        if (injection.trimStart().startsWith("<task-notification>")) {
          const noticeId = nextTranscriptId("notice");
          setTranscript((t) => [
            ...t,
            {
              id: noticeId,
              kind: "task_notice",
              text: taskNoticeTextFromNotification(injection),
              isError: /<status>(?:error|failed)<\/status>/.test(injection),
            },
          ]);
        }
      }
    }
    const userId = nextTranscriptId("u");
    turnHadVisibleOutputRef.current = false;
    quotaHandledForTurnRef.current = false;
    if (!isResume) {
      errorPanelActiveForTurnRef.current = false;
      compactTerminalRef.current = false;
    }
    const expanded = opts?.blocks
      ? { blocks: opts.blocks, text }
      : expandToContentBlocks(text, pasteStoreRef.current);
    const inlineImageBlocks = expanded.blocks.filter((b: ContentBlock) => b.type === "image");
    const handlesImageInput =
      canSendNatively(turnState.provider, turnState.model) ||
      autoRoutesNonVision(turnState.provider) ||
      Boolean(runtimeConfig.imageParserProvider);
    if (inlineImageBlocks.length > 0 && !handlesImageInput) {
      showUnsupportedImageInput(turnState.provider);
      // Release the claim taken at the top — no begin() will follow, and a
      // claim left in `dispatching` blocks the wake driver's reserve() until
      // the next user dispatch self-heals it.
      turnGuard.cancelReservation();
      return;
    }
    const expandedText = expanded.text.length > 0 ? expanded.text : text;
    if (opts?.restoreEntryId !== undefined) {
      currentTurnPromptRef.current = expandedText;
      currentTurnUserIdRef.current = opts.restoreEntryId;
    } else {
      currentTurnPromptRef.current = isResume ? null : expandedText;
      currentTurnUserIdRef.current = isResume ? null : userId;
    }
    if (!isResume) {
      session.append("user_input", { text: expandedText });
      const { pastedImages, imagePasteIds } = extractPastedImages(text, pasteStoreRef.current);
      const userRecord: UserMessageRecord = {
        type: "user_message",
        ts: nowIso(),
        content: expandedText,
        provider: turnState.provider,
        model: turnState.model,
        permissionMode: turnState.permissionMode,
        ...(pastedImages.length > 0 ? { pastedImages, imagePasteIds } : {}),
        ...(inlineImageBlocks.length > 0 ? { inlineImages: inlineImageBlocks } : {}),
        ...(opts?.isRemote ? { isRemote: true } : {}),
      };
      await appendRecord(session, userRecord).catch((err) => {
        turnGuard.cancelReservation();
        throw err;
      });
      if (currentTurnUserIdRef.current === userId && !opts?.suppressUserTranscript) {
        setTranscript((t) => [
          ...t,
          {
            id: userId,
            kind: "user",
            text: expandedText,
            ...(typeof userRecord.uuid === "string" ? { anchor: userRecord.uuid } : {}),
            ...(pastedImages.length > 0
              ? {
                  images: pastedImages.map((img) => ({
                    id: img.id,
                    mediaType: img.mediaType,
                    ...(img.localPath ? { localPath: img.localPath } : {}),
                  })),
                }
              : {}),
          },
        ]);
      }
      if (!opts?.suppressUserTranscript && !expandedText.startsWith("/")) {
        maybeGenerateSessionTitle(expandedText);
      }
    }
    const activeRewindTurnId = isResume ? null : userId;
    if (activeRewindTurnId !== null) setActiveRewindTurn(session.id, activeRewindTurnId);

    const startId = `a_${session.eventSeq}_0`;
    setStreamingId(startId);
    setStreamingText("");
    setStreamingThinking("");
    setStreamingCommittedLen(0);
    dispatch({
      type: "view/setTurnVerb",
      verb: pickVerbForTurn(turnSeedRef.current),
    });
    dispatch({ type: "view/setTurnTipIndex", index: turnSeedRef.current });
    turnSeedRef.current += 1;
    const turnStartedAt = Date.now();
    turnStartedAtRef.current = turnStartedAt;
    const turnInputEstimate = isResume
      ? 0
      : estimateTokens([...transcript, { id: userId, kind: "user", text: expandedText }], "");
    setProgressInputTokens(0);
    setLiveOutputTokens(0);
    dispatch({ type: "view/setSpinnerMode", mode: "requesting" });
    activeToolsRef.current = 0;
    resetThinkingStatus();
    turnLifecycle.beginTurn("turn", { startedAt: turnStartedAt });

    let flushTurnUsage: () => void = () => {};
    // Claim this turn's generation. begin() inside the try guarantees the finally
    // settles it even if setup throws. claim() above already reserved the guard,
    // so this should always succeed — null stays possible only if something
    // outside this gate (e.g. a skill run) called begin() directly and won the
    // race; the reads and settle below then treat this turn as not-live rather
    // than settling a generation it does not own.
    let generation: number | null = null;
    try {
      generation = turnGuard.begin();
      if (generation === null) return;
      generatorActiveRef.current = true;
      const {
        observer: turnObserver,
        flushAssistant,
        flushTurnEnd,
        freeze: freezeObserver,
        snapshot,
      } = makeTuiTurnObserver({
        startId,
        session,
        broker,
        turnState,
        recordProviderUsage,
        mergeContextUsageSnapshot,
        setStreamingText,
        setStreamingThinking,
        setStreamingCommittedLen,
        setStreamingId,
        setTranscript,
        setProgressInputTokens,
        setProgressStartedAt,
        setTasksExpanded,
        setCodexUsage,
        setMainTokenTotals,
        setMainLastContext,
        setContextWarningSuppressed,
        setAgentNested,
        setAgentBackgrounded,
        agentModelByCallIdRef,
        activeToolsRef,
        forkActionRef,
        currentAgentCallIdRef,
        forkToCallIdRef,
        turnHadVisibleOutputRef,
        turnSeedRef,
        endThinkingStatus,
        beginThinkingStatus,
        handleQuotaExhausted,
        showErrorPanel,
        agentBlockText,
        askAnswerEntry,
        silentToolNames: SILENT_TOOL_NAMES,
        dispatch,
        setLiveOutputTokens,
        emitPushEvent,
      });
      flushTurnUsage = flushTurnEnd;
      freezeObserverRef.current = freezeObserver;
      agent.setPendingUserInputDrainer(pendingInputDrainer);
      const resolvedBlocks = await resolveNonVisionImageBlocks({
        blocks: expanded.blocks,
        text,
        turnState,
        session: { id: session.id, cwd: session.cwd },
        imageParserProvider: runtimeConfig.imageParserProvider as ProviderId | undefined,
      });
      const turnBlocks = applyAdditionalContext(resolvedBlocks, opts?.additionalContext ?? []);
      await runSessionTurn(agent.runTurn(turnBlocks, text), turnObserver);
      generatorActiveRef.current = false;
      const { acc, accThinking, sawUsageEvent, progressState } = snapshot();
      if (!sawUsageEvent && turnGuard.generation === generation) {
        const estimatedOutputTokens = Math.round(progressState.responseChars / 4);
        recordProviderUsage(
          turnState.provider,
          turnState.model,
          turnInputEstimate,
          estimatedOutputTokens,
          0,
          0,
          0,
          { estimated: true },
        );
      }
      if (
        (acc.trim().length > 0 || accThinking.trim().length > 0) &&
        turnGuard.generation === generation
      ) {
        const finalEntries = await flushAssistant();
        const startedAt = turnStartedAtRef.current;
        const elapsedMs = startedAt !== null ? Date.now() - startedAt : 0;
        const durationText = formatTurnDuration(elapsedMs);
        const durationId = nextTranscriptId("turn_done");
        setTranscript((t) => [
          ...t,
          ...finalEntries,
          {
            id: durationId,
            kind: "compact_done",
            text: `${TURN_COMPLETION_VERB} for ${durationText}`,
            muted: true,
          },
        ]);
      }
    } catch (err) {
      generatorActiveRef.current = false;
      if (turnGuard.generation === generation) {
        const msg = formatTurnError(err);
        emitPushEvent("error", JSON.stringify({ message: msg }));
        const detailed = classifyProviderError(err, { attempt: 1 });
        const meta = classifyError({
          err,
          decision: detailed,
          provider: turnState.provider,
          model: turnState.model,
          attempt: 1,
          source: "stream-retry",
        });
        if (meta.errorClass !== "subagent-background") {
          showErrorPanel(meta);
          pendingErrorRevokeRef.current = !turnHadVisibleOutputRef.current;
        } else if (!turnHadVisibleOutputRef.current) {
          revokeLastUnansweredUserMessage(session);
        }
      }
    } finally {
      flushTurnUsage();
      freezeObserverRef.current = null;
      // Ownership check: if the generation has moved on, a NEWER turn is already
      // live (a stalled cancelled-turn teardown raced a promotion) — clearing
      // these here would clobber ITS streaming state. A cancelled turn's own
      // streaming state was already cleared by stageCancelTurn/the grace timer,
      // so skipping here loses nothing for that case.
      if (turnGuard.generation === generation) {
        dispatch({ type: "view/setRetryStatus", status: null });
        setStreamingId(null);
        setStreamingText("");
        setStreamingThinking("");
        setStreamingCommittedLen(0);
      }
      // Turn-scoped Agent bookkeeping: per-tool entries are dropped on
      // tool_dispatch_complete/backgrounded, but a cancelled or errored turn can
      // abort an in-flight Agent tool before that fires, orphaning its entry.
      // Turns are serialised and the loop has stopped by the finally, so any
      // remainder is dead — clear it. (forkToCallIdRef is left alone: a
      // backgrounded fork keeps its entry until its own fork_complete.)
      agentModelByCallIdRef.current.clear();
      forkActionRef.current.clear();
      if (activeRewindTurnId !== null) setActiveRewindTurn(session.id, null);
      // settle() is false when this turn was cancelled (abort bumped the
      // generation) or superseded: the turn's own resume of ITSELF is dropped so
      // the cancel is not undone by a racing re-dispatch (the come-back fix). The
      // turn's own UI teardown still runs in the else branch below either way.
      const isLiveTurn = generation !== null && turnGuard.settle(generation);
      // Bug B (force-promote on cancel): even a cancelled/superseded turn must
      // drain the queue so OTHER messages queued behind it are not stranded — but
      // only if it can atomically claim the guard. reserve() (idle→dispatching)
      // loses to a real new turn that already began (running), in which case we
      // leave the queue for that turn. The promoted messages are DIFFERENT from
      // the cancelled prompt (that stays gated on settle above → no come-back);
      // the runSubmittedTurn dispatch below consumes the reservation via begin().
      const promoteQueued = !isLiveTurn && getQueueMessages().length > 0 && turnGuard.reserve();
      let promotionDispatched = false;
      const continuation =
        isLiveTurn || promoteQueued
          ? postTurnDrain()
          : { nextText: null, nextSuppress: false, nextRestoreEntryId: undefined };
      if (continuation.nextText !== null) {
        // Turn-scoped resets + endTurn only for the slash branch: a promoted
        // slash may not start a new turn at all (a handled command, or a
        // hook-blocked fallback), so the UI must fall back to idle before it
        // runs. The text branch skips this and lets the recursive
        // runSubmittedTurn's own beginTurn overwrite this turn's state directly,
        // avoiding a busy-false-then-true flicker between the two turns.
        if (continuation.nextText.trim().startsWith("/")) {
          currentTurnPromptRef.current = null;
          currentTurnUserIdRef.current = null;
          turnHadVisibleOutputRef.current = false;
          quotaHandledForTurnRef.current = false;
          turnLifecycle.endTurn("turn");
        }
        promotionDispatched = await promoteContinuation(continuation);
      } else {
        currentTurnPromptRef.current = null;
        currentTurnUserIdRef.current = null;
        turnHadVisibleOutputRef.current = false;
        quotaHandledForTurnRef.current = false;
        turnLifecycle.endTurn("turn");
        void import("@/remote/index.ts").then((r) => r.setSessionStatus("idle")).catch(() => {});
        requestBackgroundResume();
      }
      // A forced promotion that reserved the guard but never dispatched a turn
      // (queue held only pending-changes, a handled slash, or a hook-blocked
      // prompt) would otherwise strand the guard in `dispatching`; release it.
      if (promoteQueued && !promotionDispatched) turnGuard.cancelReservation();
    }
  };

  // Defined after runSubmittedTurn so it can close over it for recursive
  // promotion; only invoked once module setup completes, so the forward
  // reference is safe.
  const promoteContinuation = createPromoteContinuation({
    runtimeConfig,
    setTranscript,
    handleSlash,
    runSubmittedTurn,
    requestBackgroundResume,
  });

  return runSubmittedTurn;
}
