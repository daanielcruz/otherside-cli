import { getProviderConfig } from "@/engine/contract/registry.ts";
import { applyCodexQuotaWarning, type CodexUsage } from "@/engine/providers/codex/usage.ts";
import { createGoalEventHandlers } from "@/engine/queue/turn/goal-events.ts";
import type { TurnObserver } from "@/engine/queue/turn/observer.ts";
import { emptyProgressState } from "@/engine/queue/turn/progress.ts";
import { createStreamCommitter } from "@/engine/queue/turn/stream-committer.ts";
import { createToolDispatchHandlers } from "@/engine/queue/turn/tool-dispatch-handlers.ts";
import { createTurnUsageTracker } from "@/engine/queue/turn/usage-tracker.ts";
import { pickVerbForTurn } from "@/engine/queue/turn/verb.ts";
import { estimateHarnessTokens } from "@/engine/session/compact/harness-baseline.ts";
import { clearLastUsage } from "@/engine/session/compact/last-usage.ts";
import { MICRO_COMPACT_CLEARED_MESSAGE } from "@/engine/session/compact/micro.ts";
import { estimateConversationTokens } from "@/engine/session/compact/token-count.ts";
import { appendRecord, nowIso, type Session } from "@/engine/session/index.ts";
import {
  applyAgentIdentityToTranscript,
  rewriteClearedToolResults,
} from "@/engine/session/record/transcript-update.ts";
import type {
  NestedToolEntry,
  TranscriptEntry,
  TranscriptWrite,
} from "@/engine/session/record/types.ts";
import { emptyTokenTotals, type TokenTotals } from "@/engine/session/usage/provider.ts";
import type { ContextUsageSnapshot } from "@/engine/session/usage/snapshot.ts";
import type { ErrorMeta } from "@/engine/transport/error-meta.ts";
import { emitQueuedInputDrained } from "@/kernel/channels/session-events.ts";
import { mcpCallIdentity } from "@/kernel/mcp/index.ts";
import type { MacrotaskBatch } from "@/kernel/std/perf/macrotask-batch.ts";
import type { ToolResultMeta } from "@/kernel/std/types/message.ts";
import type { ProviderId, ProviderModelRoute } from "@/kernel/std/types/provider-ids.ts";
import type { BrokerHandle } from "@/kernel/std/types/request.ts";
import type { SpinnerMode } from "@/kernel/std/types/spinner-mode.ts";

type SetState<T> = (value: T | ((prev: T) => T)) => void;
type Ref<T> = { current: T };
type BrokerState = ReturnType<BrokerHandle["read"]>;
type RetryStatus = {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  startedAt: number;
  reason: string;
  status?: number;
  message?: string;
} | null;
type TuiViewAction =
  | { type: "view/setSpinnerMode"; mode: SpinnerMode }
  | { type: "view/setRetryStatus"; status: RetryStatus }
  | { type: "view/setTurnVerb"; verb: string };

export interface TuiTurnObserverDeps {
  startId: string;
  session: Session;
  broker: BrokerHandle;
  turnState: BrokerState;
  recordProviderUsage: (
    provider: ProviderId,
    model: string,
    inputTokens?: number,
    outputTokens?: number,
    thoughtTokens?: number,
    cacheCreationInputTokens?: number,
    cacheReadInputTokens?: number,
    options?: {
      countRequest?: boolean;
      estimated?: boolean;
      isFork?: boolean;
      contextUsage?: ContextUsageSnapshot;
    },
  ) => void;
  mergeContextUsageSnapshot: (
    previous: ContextUsageSnapshot,
    event: {
      inputTokens?: number | undefined;
      outputTokens?: number | undefined;
      cacheCreationInputTokens?: number | undefined;
      cacheReadInputTokens?: number | undefined;
    },
  ) => ContextUsageSnapshot;
  setStreamingText: SetState<string>;
  setStreamingThinking: SetState<string>;
  setStreamingCommittedLen: SetState<number>;
  setStreamingId: SetState<string | null>;
  setTranscript: (value: TranscriptWrite) => void;
  transcriptBatch: MacrotaskBatch;
  setProgressInputTokens: SetState<number>;
  setProgressStartedAt: SetState<number | null>;
  setTasksExpanded: SetState<boolean>;
  setCodexUsage: SetState<CodexUsage | null>;
  setMainTokenTotals: SetState<TokenTotals>;
  setMainLastContext: SetState<ContextUsageSnapshot>;
  setContextWarningSuppressed: SetState<boolean>;
  setAgentNested: (
    callId: string,
    mutator: (entries: NestedToolEntry[]) => NestedToolEntry[],
  ) => void;
  setAgentBackgrounded: (callId: string, route?: ProviderModelRoute) => void;
  agentModelByCallIdRef: Ref<Map<string, ProviderModelRoute>>;
  activeToolsRef: Ref<number>;
  forkActionRef: Ref<Map<string, { count: number; lastLabel: string; backgrounded: boolean }>>;
  currentAgentCallIdRef: Ref<string | null>;
  forkToCallIdRef: Ref<Map<string, string>>;
  turnHadVisibleOutputRef: Ref<boolean>;
  turnSeedRef: Ref<number>;
  endThinkingStatus: () => void;
  beginThinkingStatus: () => void;
  handleQuotaExhausted: (resetEpochMs: number | null) => void;
  showErrorPanel: (meta: ErrorMeta) => void;
  agentBlockText: (toolName: string, callId: string, input: unknown) => string;
  askAnswerEntry: (content: string, id: string, meta?: ToolResultMeta) => TranscriptEntry | null;
  silentToolNames: ReadonlySet<string>;
  dispatch: (action: TuiViewAction) => void;
  setLiveOutputTokens: (value: number) => void;
  emitPushEvent: (eventType: string, plaintext: string) => void;
}

export interface TuiTurnHandle {
  observer: TurnObserver;
  flushAssistant: (opts?: { allowEmpty?: boolean }) => Promise<TranscriptEntry[]>;
  flushUsage: () => void;
  flushTurnEnd: () => void;
  freeze: () => void;
  snapshot: () => {
    acc: string;
    accThinking: string;
    sawUsageEvent: boolean;
    progressState: ReturnType<typeof emptyProgressState>;
  };
}

export function makeTuiTurnObserver(deps: TuiTurnObserverDeps): TuiTurnHandle {
  const {
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
    transcriptBatch,
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
    silentToolNames,
    dispatch,
    setLiveOutputTokens,
    emitPushEvent,
  } = deps;

  // The provider that opened the CURRENT stream attempt (stamped on its
  // message_start). Defaults to the turn-start snapshot until the first
  // attempt reports in.
  let attemptProvider = turnState.provider as ProviderId;

  const usageTracker = createTurnUsageTracker({
    session,
    turnState,
    recordProviderUsage,
    mergeContextUsageSnapshot,
    setProgressInputTokens,
    setLiveOutputTokens,
  });
  const committer = createStreamCommitter({
    startId,
    session,
    turnState,
    setStreamingText,
    setStreamingThinking,
    setStreamingCommittedLen,
    setTranscript,
    takeRequestUsageStamp: usageTracker.takeRequestUsageStamp,
    appendUsageOnlyAssistantRecord: usageTracker.appendUsageOnlyAssistantRecord,
    // A promoted headline rides the turn's existing verb channel — it lives
    // for the rest of this turn step and is overwritten by the next headline
    // or by the next turn's pickVerbForTurn roll (submitted-turn.ts).
    onThinkingHeadline: (headline) => dispatch({ type: "view/setTurnVerb", verb: headline }),
    // Classify reasoning by the route that PRODUCED the attempt (stamped on
    // message_start), never by the live broker: a mid-stream route switch must
    // not flip headline stripping while the old provider's bytes still arrive.
    reasoningHeadlinesEnabled: () =>
      getProviderConfig(attemptProvider)?.featureFlags?.reasoningHeadlines === true,
  });
  const toolHandlers = createToolDispatchHandlers({
    session,
    turnState,
    endThinkingStatus,
    setSpinnerMode: (mode) => dispatch({ type: "view/setSpinnerMode", mode }),
    flushAssistant: committer.flushAssistant,
    setStreamingId,
    setTranscript,
    transcriptBatch,
    setTasksExpanded,
    setAgentBackgrounded,
    agentModelByCallIdRef,
    activeToolsRef,
    forkActionRef,
    currentAgentCallIdRef,
    turnHadVisibleOutputRef,
    agentBlockText,
    askAnswerEntry,
    silentToolNames,
  });

  const goalHandlers = createGoalEventHandlers({
    session,
    setTranscript,
    turnHadVisibleOutputRef,
  });
  const observer: TurnObserver = {
    onAny: (ev) => {
      usageTracker.applyToProgress(ev);
      if (ev.kind !== "retry_status" && ev.kind !== "fork_retry_status") {
        dispatch({ type: "view/setRetryStatus", status: null });
      }
    },
    text_delta: (ev) => {
      endThinkingStatus();
      dispatch({ type: "view/setSpinnerMode", mode: "responding" });
      turnHadVisibleOutputRef.current = true;
      committer.addText(ev.text);
    },
    thinking_delta: (ev) => {
      dispatch({ type: "view/setSpinnerMode", mode: "thinking" });
      beginThinkingStatus();
      turnHadVisibleOutputRef.current = true;
      committer.addThinking(ev.text);
    },
    thinking_signature: (ev) => {
      committer.setSignature(ev.signature);
    },
    message_start: (ev) => {
      const previousAttemptProvider = attemptProvider;
      if (ev.provider !== undefined) attemptProvider = ev.provider;
      // A route switch away from a headline-promoting provider strands its
      // last headline on the verb channel; roll the turn's own verb back.
      if (
        attemptProvider !== previousAttemptProvider &&
        getProviderConfig(attemptProvider)?.featureFlags?.reasoningHeadlines !== true
      ) {
        dispatch({ type: "view/setTurnVerb", verb: pickVerbForTurn(turnSeedRef.current) });
      }
      usageTracker.resetForMessageStart();
    },
    usage: (ev) => {
      usageTracker.applyUsageEvent(ev);
    },
    usage_limits: (ev) => {
      if (ev.provider === "codex") {
        const codexEvUsage = ev.usage as CodexUsage;
        setCodexUsage(codexEvUsage);
        applyCodexQuotaWarning(codexEvUsage);
      }
    },
    message_stop: () => {
      endThinkingStatus();
      usageTracker.flushUsage();
      // The protocol stop does not settle the assistant record. Keep the flushed
      // live tail mounted until flushAssistant publishes its settled replacement;
      // the turn owner clears live state after that handoff.
      committer.flushLive();
    },
    ...toolHandlers,
    micro_compact: (ev) => {
      if (ev.clearedToolUseIds && ev.clearedToolUseIds.length > 0) {
        const clearedSet: ReadonlySet<string> = new Set(ev.clearedToolUseIds);
        setTranscript((t) =>
          rewriteClearedToolResults(t, clearedSet, MICRO_COMPACT_CLEARED_MESSAGE),
        );
      }
    },
    compact_start: async () => {
      endThinkingStatus();
      const flushed = await committer.flushAssistant();
      if (flushed.length > 0) setStreamingId(null);
      setProgressStartedAt(Date.now());
      dispatch({ type: "view/setTurnVerb", verb: "Compacting conversation" });
    },
    compact_done: (ev) => {
      dispatch({ type: "view/setRetryStatus", status: null });
      // A failed compaction leaves the conversation exactly as it was, so every
      // reading of it has to survive too. Zeroing the totals here reported an
      // empty context for a full one — and a summary request dying on a dropped
      // connection is the common way to reach this branch.
      if (ev.mode !== "failed") {
        setMainTokenTotals(emptyTokenTotals());
        clearLastUsage();
        const brokerNow = broker.read();
        setMainLastContext({
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens:
            estimateConversationTokens(session.messages) +
            estimateHarnessTokens(brokerNow.provider, brokerNow.model),
          cacheCreationInputTokens: 0,
        });
        setContextWarningSuppressed(true);
      }
      setProgressInputTokens(0);
      setLiveOutputTokens(0);
      dispatch({ type: "view/setTurnVerb", verb: pickVerbForTurn(turnSeedRef.current) });
      const seconds = Math.max(0, Math.round(ev.durationMs / 1000));
      const text =
        ev.mode === "failed"
          ? `Conversation compact failed (${seconds}s) — ${ev.error ?? "summary fork failed"}`
          : ev.truncatedMessages > 0
            ? `Conversation compacted (${seconds}s · truncated ${ev.truncatedMessages} oldest message${ev.truncatedMessages === 1 ? "" : "s"})`
            : `Conversation compacted (${seconds}s)`;
      setTranscript((t) => [
        ...t,
        {
          id: `compact_done_${session.eventSeq}_${t.length}`,
          kind: "compaction",
          text,
          muted: true,
          ...(ev.mode === "failed" ? { isError: true } : {}),
          ...(ev.restoredFiles && ev.restoredFiles.length > 0
            ? { filesRead: ev.restoredFiles }
            : {}),
        },
      ]);
    },
    ...goalHandlers,
    queued_input_drained: async (ev) => {
      emitQueuedInputDrained(ev.messages);
      const flushed = await committer.flushAssistant();
      if (flushed.length > 0) {
        const nextId = `a_${session.eventSeq}_${Date.now()}`;
        committer.setCurId(nextId);
        setStreamingId(nextId);
      }
      const baseId = `qmid_${Date.now()}`;
      setTranscript((t) => [
        ...t,
        ...ev.messages.map((msg, i) => ({
          id: `${baseId}_${i}`,
          kind: "user" as const,
          text: msg.text,
          ...(msg.pastedImages && msg.pastedImages.length > 0
            ? {
                images: msg.pastedImages.map((img) => ({
                  id: img.id,
                  mediaType: img.mediaType,
                  ...(img.localPath ? { localPath: img.localPath } : {}),
                })),
              }
            : {}),
        })),
      ]);
      for (const msg of ev.messages) {
        session.append("user_input", { text: msg.text });
        const inlineImages = msg.blocks.filter((b) => b.type === "image");
        const remotePayload =
          msg.remotePayload && typeof msg.remotePayload === "object"
            ? (msg.remotePayload as Record<string, unknown>)
            : null;
        const remoteAttachments = Array.isArray(remotePayload?.attachments)
          ? remotePayload.attachments
          : [];
        const queueId = remotePayload
          ? (remotePayload.queueId ?? remotePayload.queue_id ?? remotePayload.id)
          : undefined;
        await appendRecord(session, {
          type: "user_message",
          ts: nowIso(),
          content: msg.text,
          provider: turnState.provider,
          model: turnState.model,
          ...(msg.pastedImages && msg.pastedImages.length > 0
            ? {
                pastedImages: msg.pastedImages,
                imagePasteIds: msg.pastedImages.map((img) => img.id),
              }
            : {}),
          ...(remoteAttachments.length > 0 ? { attachments: remoteAttachments } : {}),
          ...(inlineImages.length > 0 ? { inlineImages } : {}),
          ...(msg.remotePayload ? { isRemote: true } : {}),
          ...(typeof queueId === "string" ? { queueId } : {}),
        });
      }
    },
    fork_start: (ev) => {
      const callId = ev.parentToolCallId ?? forkToCallIdRef.current.get(ev.forkId);
      if (callId) {
        agentModelByCallIdRef.current.set(callId, { provider: ev.provider, model: ev.model });
        setTranscript((entries) =>
          applyAgentIdentityToTranscript(entries, callId, {
            model: ev.model,
            provider: ev.provider,
            name: ev.name,
          }),
        );
      }
    },
    fork_tool_dispatch_start: (ev) => {
      const callId =
        ev.parentToolCallId ??
        forkToCallIdRef.current.get(ev.forkId) ??
        currentAgentCallIdRef.current;
      if (callId) {
        // A nested row is never persisted, so its identity has to be read while
        // the server is still registered — the row outlives the fork that made it.
        const nestedIdentity = mcpCallIdentity(ev.toolName);
        setAgentNested(callId, (prev) => [
          ...prev,
          {
            toolName: ev.toolName,
            args: ev.input,
            running: true,
            ...(nestedIdentity ? { mcpIdentity: nestedIdentity } : {}),
          },
        ]);
      }
    },
    fork_tool_dispatch_complete: (ev) => {
      const callId =
        ev.parentToolCallId ??
        forkToCallIdRef.current.get(ev.forkId) ??
        currentAgentCallIdRef.current;
      if (callId) {
        setAgentNested(callId, (prev) => {
          const idx = prev.findIndex((e) => e.toolName === ev.toolName && e.running);
          if (idx === -1) return prev;
          const out = [...prev];
          const existing = out[idx];
          if (existing) out[idx] = { ...existing, running: false };
          return out;
        });
      }
    },
    fork_usage: (ev) => {
      if (ev.isSnapshot) return;
      recordProviderUsage(
        ev.provider ?? turnState.provider,
        ev.model ?? turnState.model,
        ev.inputTokens,
        ev.outputTokens,
        ev.thoughtTokens ?? 0,
        ev.cacheCreationInputTokens ?? 0,
        ev.cacheReadInputTokens ?? 0,
        { isFork: true },
      );
    },
    turn_end: async (ev) => {
      if (ev.stopReason !== "tool_calls") return;
      endThinkingStatus();
      // Settle under the current ID before handing the live slot to the response
      // that follows tool execution. A later tool_dispatch_start flush is empty.
      await committer.flushAssistant();
      const nextId = `a_${session.eventSeq}_${ev.turn + 1}`;
      committer.setCurId(nextId);
      setStreamingId(nextId);
    },
    retry_status: (ev) => {
      if (ev.attempt < 4) {
        dispatch({ type: "view/setRetryStatus", status: null });
      } else {
        dispatch({
          type: "view/setRetryStatus",
          status: {
            attempt: ev.attempt,
            maxAttempts: ev.maxAttempts,
            delayMs: ev.delayMs,
            startedAt: Date.now(),
            reason: ev.reason,
            ...(typeof ev.status === "number" ? { status: ev.status } : {}),
            ...(typeof ev.message === "string" ? { message: ev.message } : {}),
          },
        });
      }
    },
    stream_reset: () => {
      // The failed attempt's partial output is void — drop it from the live
      // stream and the transcript before the transparent re-send repaints it.
      endThinkingStatus();
      committer.reset();
    },
    error: (ev) => {
      endThinkingStatus();
      turnHadVisibleOutputRef.current = true;
      emitPushEvent("error", JSON.stringify({ message: ev.error }));
      if (ev.meta && ev.meta.errorClass !== "subagent-background") {
        showErrorPanel(ev.meta);
      }
    },
    quota_exhausted: (ev) => {
      endThinkingStatus();
      // Soft rate-limit exhaustion (429/529 retries spent — e.g. a transient
      // grok/glm 429 that is NOT usage) is a contained error, never the
      // plan-quota UI: the provider is already on cooldown, the turn ends on
      // its own, and the error panel carries the retry context.
      if (ev.reason === "rate_limited") {
        turnHadVisibleOutputRef.current = true;
        emitPushEvent("error", JSON.stringify({ message: ev.message }));
        if (ev.meta) showErrorPanel(ev.meta);
        return;
      }
      handleQuotaExhausted(ev.resetEpochMs);
    },
    fork_quota_exhausted: (ev) => {
      // A fork's soft rate limit already surfaced as that fork's contained
      // error tool_result; cancelling the whole turn (and every sibling fork)
      // for it would trade one dead agent for a dead turn.
      if (ev.reason === "rate_limited") return;
      handleQuotaExhausted(ev.resetEpochMs);
    },
    fork_retry_status: (ev) => {
      if (ev.attempt < 4) {
        dispatch({ type: "view/setRetryStatus", status: null });
      } else {
        dispatch({
          type: "view/setRetryStatus",
          status: {
            attempt: ev.attempt,
            maxAttempts: ev.maxAttempts,
            delayMs: ev.delayMs,
            startedAt: Date.now(),
            reason: ev.reason,
          },
        });
      }
    },
  };

  return {
    observer,
    flushAssistant: committer.flushAssistant,
    flushUsage: usageTracker.flushUsage,
    flushTurnEnd: usageTracker.flushTurnEnd,
    freeze: committer.freeze,
    snapshot: () => ({ ...committer.snapshot(), ...usageTracker.snapshot() }),
  };
}
