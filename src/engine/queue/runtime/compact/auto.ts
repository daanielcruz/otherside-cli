import { findModel } from "@/engine/model/catalog.ts";
import * as providers from "@/engine/providers/registry.ts";
import { currentLocalISODate } from "@/engine/queue/runtime/turn-prompts.ts";
import { pruneContentReplacementStateForSession } from "@/engine/session/compact/content-replacement-prune.ts";
import { groupByApiRound } from "@/engine/session/compact/grouping.ts";
import {
  AUTOCOMPACT_RAPID_REFILL_ERROR_MESSAGE,
  getModelAutoCompactThreshold,
  MAX_CONSECUTIVE_RAPID_REFILLS,
  maxOutputTokensForModel,
  RAPID_REFILL_TURN_THRESHOLD,
} from "@/engine/session/compact/index.ts";
import { clearLastUsage } from "@/engine/session/compact/last-usage.ts";
import {
  computePeelStep,
  tokensForGroup,
  zeroAssistantUsage,
} from "@/engine/session/compact/peel.ts";
import { preserveMetadataForTail } from "@/engine/session/compact/preserved-metadata.ts";
import {
  buildPostCompactRehydration,
  collectImageBlocks,
  POST_COMPACT_MAX_IMAGES,
} from "@/engine/session/compact/rehydration.ts";
import {
  CompactPromptTooLongError,
  summarizeConversation,
} from "@/engine/session/compact/summary.ts";
import { estimateTokens } from "@/engine/session/compact/token-count.ts";
import { appendRecord, nowIso, sessionPathForCwd } from "@/engine/session/index.ts";
import { MAIN_SCOPE, readSetClearExcept } from "@/engine/tools/builtins/read/state.ts";
import { assembleProviderTurn, type ProviderToolDeclaration } from "@/engine/translator/index.ts";
import type { ComposedHarness } from "@/harness/composer/injections.ts";
import { makeQueue } from "@/harness/composer/queue.ts";
import {
  formatCompactSummary,
  getCompactUserSummaryMessage,
} from "@/harness/routines/compact/index.ts";
import { fireConfiguredHooks } from "@/kernel/hooks/handler.ts";
import { isEnvTruthy } from "@/kernel/std/proc/env.ts";
import { AsyncStream } from "@/kernel/std/stream/async.ts";
import type { AgentEvent, ProviderEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  type CompactOrchestrationDeps,
  type CompactState,
  computeUsedContextTokens,
  MAX_CONSECUTIVE_COMPACT_FAILURES,
  resolveCompactWindow,
  splitPreservedTail,
} from "./support.ts";

interface PeeledSummary {
  summary: string;
  droppedMessages: number;
  preservedTail: Message[];
}

// Failed summaries and failed boundary writes must not mutate persisted compact
// state, but a turn still gets only one automatic compaction attempt.
const attemptedAutoCompactTurns = new WeakMap<CompactState, string>();

async function summarizeAll(
  ctx: RequestContext,
  messages: Message[],
  tools: ProviderToolDeclaration[],
  onEvent: (ev: ProviderEvent) => void,
  harness?: ComposedHarness,
): Promise<PeeledSummary> {
  const result = await summarizeConversation(ctx, messages, tools, undefined, onEvent, harness);
  return { summary: result.summary, droppedMessages: result.droppedMessages, preservedTail: [] };
}

async function runIncrementalCompact(
  ctx: RequestContext,
  messages: Message[],
  tools: ProviderToolDeclaration[],
  onEvent: (ev: ProviderEvent) => void,
  harness?: ComposedHarness,
): Promise<PeeledSummary> {
  const groups = groupByApiRound(messages);
  const totalGroups = groups.length;
  if (totalGroups < 2) return summarizeAll(ctx, messages, tools, onEvent, harness);
  let groupTokens: number[] | undefined;
  let preserveCount = 1;
  while (preserveCount < totalGroups) {
    const splitAt = totalGroups - preserveCount;
    const { toSummarize, preservedTail } = splitPreservedTail(messages, preserveCount);
    if (preservedTail.length === 0) return summarizeAll(ctx, messages, tools, onEvent, harness);
    try {
      const result = await summarizeConversation(
        ctx,
        toSummarize,
        tools,
        undefined,
        onEvent,
        harness,
      );
      return {
        summary: result.summary,
        droppedMessages: result.droppedMessages,
        preservedTail: preservedTail.map(zeroAssistantUsage),
      };
    } catch (err) {
      if (!(err instanceof CompactPromptTooLongError)) throw err;
      groupTokens ??= groups.map(tokensForGroup);
      preserveCount += computePeelStep(err.tokenGap, groupTokens, splitAt);
    }
  }
  return summarizeAll(ctx, messages, tools, onEvent, harness);
}

export async function* maybeCompact(deps: CompactOrchestrationDeps): AsyncIterable<AgentEvent> {
  if (deps.agentDeps.config.autoCompact === false) return;
  if (
    isEnvTruthy(process.env.OTHERSIDE_DISABLE_COMPACT) ||
    isEnvTruthy(process.env.OTHERSIDE_DISABLE_AUTO_COMPACT)
  )
    return;
  const stateBeforeAttempt = snapshotCompactState(deps.state);
  // Both breakers re-arm once the context refilled slowly (past the rapid
  // threshold): auto-compaction is the only bound on session.messages growth,
  // so neither a thrash nor three transient summarization failures (e.g. a
  // network blip) may disable it for the rest of the session. A genuine
  // repeat just re-trips the breaker.
  const failureBreakerOpen =
    deps.state.consecutiveCompactFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES;
  const rearmFailureBreaker =
    failureBreakerOpen && deps.state.turnsSinceLast >= RAPID_REFILL_TURN_THRESHOLD;
  if (failureBreakerOpen && !rearmFailureBreaker) return;
  const rearmRapidRefillBreaker =
    deps.state.rapidRefillBreakerOpen && deps.state.turnsSinceLast >= RAPID_REFILL_TURN_THRESHOLD;
  if (deps.state.rapidRefillBreakerOpen && !rearmRapidRefillBreaker) return;

  const state = deps.agentDeps.broker.read();
  const model = findModel(state.model, state.provider);
  if (!model) return;
  const window = resolveCompactWindow(model);
  const maxOutput = maxOutputTokensForModel(state.model);
  const lastUsage = deps.agentDeps.getLastUsage?.() ?? null;
  const threshold = getModelAutoCompactThreshold({
    model,
    window,
    maxOutputTokens: maxOutput,
    provider: state.provider,
  });
  const used = computeUsedContextTokens(
    deps.agentDeps.session.messages,
    lastUsage,
    state.provider,
    state.model,
  );
  if (used < threshold) return;
  if (
    deps.turnId !== null &&
    (deps.state.lastAutoCompactAttemptTurnId === deps.turnId ||
      attemptedAutoCompactTurns.get(deps.state) === deps.turnId)
  )
    return;
  if (deps.turnId !== null) attemptedAutoCompactTurns.set(deps.state, deps.turnId);

  const rapidRefillCount =
    deps.state.turnsSinceLast < RAPID_REFILL_TURN_THRESHOLD
      ? (rearmRapidRefillBreaker ? 0 : deps.state.rapidRefillCount) + 1
      : 0;
  const attemptState: CompactState = {
    rapidRefillBreakerOpen: false,
    rapidRefillCount,
    consecutiveCompactFailures: rearmFailureBreaker ? 0 : deps.state.consecutiveCompactFailures,
    turnsSinceLast: deps.state.turnsSinceLast,
    lastAutoCompactAttemptTurnId: deps.turnId,
  };
  if (rapidRefillCount >= MAX_CONSECUTIVE_RAPID_REFILLS) {
    attemptState.rapidRefillBreakerOpen = true;
    applyCompactState(deps.state, attemptState);
    yield {
      kind: "compact_done",
      mode: "failed",
      droppedMessages: 0,
      truncatedMessages: 0,
      preTokens: used,
      durationMs: 0,
      error: AUTOCOMPACT_RAPID_REFILL_ERROR_MESSAGE,
    };
    return;
  }
  const before = deps.agentDeps.session.messages.length;
  if (before === 0) return;
  yield { kind: "compact_start", preTokens: used, threshold, window };
  const transcriptPath = sessionPathForCwd(
    deps.agentDeps.session.storageCwd,
    deps.agentDeps.session.id,
  );
  await fireConfiguredHooks(deps.agentDeps.config, "preCompact", {
    kind: "preCompact",
    ctx: {
      sessionId: deps.agentDeps.session.id,
      transcriptPath,
      trigger: "auto",
    },
  });
  const ctx = deps.makeCtx();
  const ac = deps.activeAbortController();
  if (ac) ctx.abortSignal = ac.signal;
  const start = Date.now();
  const provider = providers.get(ctx.provider);
  const summaryInjections = makeQueue();
  for (const injection of deps.injections.peek()) summaryInjections.push(injection);
  const turn = assembleProviderTurn({
    ctx,
    provider,
    messages: deps.agentDeps.session.messages,
    injections: summaryInjections,
    config: deps.agentDeps.config,
    currentDate: currentLocalISODate(),
  });
  // Thread the assembled agent harness into the summary request so system
  // bytes match the conversation's prompt-cache prefix.
  const queue = new AsyncStream<ProviderEvent>();
  let summarizeSettled = false;
  const summarizePromise = runIncrementalCompact(
    ctx,
    deps.agentDeps.session.messages,
    turn.tools,
    (ev) => queue.push(ev),
    turn.harness,
  ).finally(() => {
    summarizeSettled = true;
    queue.signal();
  });
  let boundaryAppended = false;
  let summaryProduced = false;
  try {
    for await (const ev of queue.iterate(() => summarizeSettled)) {
      if (ev.kind === "retry_status") yield ev;
    }
    const result = await summarizePromise;
    summaryProduced = true;
    const formatted = formatCompactSummary(result.summary);
    if (!formatted || formatted === "Summary:" || formatted.length < 50) {
      deps.state.consecutiveCompactFailures = attemptState.consecutiveCompactFailures + 1;
      yield {
        kind: "compact_done",
        mode: "failed",
        droppedMessages: 0,
        truncatedMessages: 0,
        preTokens: used,
        durationMs: Date.now() - start,
        error: "Auto-compaction produced an empty or invalid summary",
      };
      return;
    }
    const preservedTail = result.preservedTail;
    const summaryMessage = getCompactUserSummaryMessage(result.summary, {
      suppressFollowUpQuestions: true,
      transcriptPath,
    });
    const preservedImages = collectImageBlocks(deps.agentDeps.session.messages).slice(
      -POST_COMPACT_MAX_IMAGES,
    );
    const { blocks: rehydrationBlocks, restoredFiles } = buildPostCompactRehydration(
      state.permissionMode,
      preservedImages,
    );
    const newAutoMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: summaryMessage }] },
    ];
    if (rehydrationBlocks.length > 0) {
      newAutoMessages.push({ role: "user", content: rehydrationBlocks });
    }
    newAutoMessages.push(...preservedTail);
    const beforeAutoTokens = estimateTokens(deps.agentDeps.session.messages);
    const boundaryUuid = crypto.randomUUID();
    const preserveMetadata = preserveMetadataForTail(
      deps.agentDeps.session.records,
      preservedTail,
      boundaryUuid,
    );

    await appendRecord(deps.agentDeps.session, {
      type: "compaction_mark",
      ts: nowIso(),
      uuid: boundaryUuid,
      summary_ref: result.summary,
      provider: state.provider,
      model: state.model,
      version: 1,
      preTokens: beforeAutoTokens,
      trigger: "auto",
      ...(preserveMetadata ?? {}),
      ...(preservedImages.length > 0 ? { preservedImages } : {}),
    });
    boundaryAppended = true;

    deps.agentDeps.session.messages.splice(
      0,
      deps.agentDeps.session.messages.length,
      ...newAutoMessages,
    );
    clearLastUsage();
    readSetClearExcept(
      MAIN_SCOPE,
      restoredFiles.map((file) => file.path),
    );
    deps.clearNestedMemory?.();
    pruneContentReplacementStateForSession(deps.agentDeps.session);
    deps.injections.drain();
    const compactBoundaryIdx = deps.agentDeps.session.records.findLastIndex(
      (r) => r.type === "compaction_mark",
    );
    if (compactBoundaryIdx > 0) {
      deps.agentDeps.session.records.splice(0, compactBoundaryIdx);
    }
    applyCompactState(deps.state, {
      ...attemptState,
      turnsSinceLast: 0,
      consecutiveCompactFailures: 0,
    });
    await fireConfiguredHooks(deps.agentDeps.config, "postCompact", {
      kind: "postCompact",
      ctx: {
        sessionId: deps.agentDeps.session.id,
        transcriptPath,
        trigger: "auto",
      },
    });
    yield {
      kind: "compact_done",
      mode: "summary",
      droppedMessages: before - 1,
      truncatedMessages: result.droppedMessages,
      preTokens: used,
      durationMs: Date.now() - start,
      summary: result.summary,
      restoredFiles,
    };
  } catch (err) {
    if (!boundaryAppended) applyCompactState(deps.state, stateBeforeAttempt);
    const aborted = ctx.abortSignal?.aborted === true;
    // Only a summarization failure advances the breaker: a user cancel is not
    // a failure, and a local append error already rolled the plan back whole.
    if (!summaryProduced && !aborted) {
      deps.state.consecutiveCompactFailures = attemptState.consecutiveCompactFailures + 1;
    }
    const reason = aborted
      ? "compaction cancelled"
      : err instanceof Error
        ? err.message
        : String(err);
    yield {
      kind: "compact_done",
      mode: "failed",
      droppedMessages: 0,
      truncatedMessages: 0,
      preTokens: used,
      durationMs: Date.now() - start,
      error: reason,
    };
  }
}

function snapshotCompactState(state: CompactState): CompactState {
  return {
    rapidRefillBreakerOpen: state.rapidRefillBreakerOpen,
    rapidRefillCount: state.rapidRefillCount,
    consecutiveCompactFailures: state.consecutiveCompactFailures,
    turnsSinceLast: state.turnsSinceLast,
    lastAutoCompactAttemptTurnId: state.lastAutoCompactAttemptTurnId,
  };
}

function applyCompactState(target: CompactState, source: CompactState): void {
  target.rapidRefillBreakerOpen = source.rapidRefillBreakerOpen;
  target.rapidRefillCount = source.rapidRefillCount;
  target.consecutiveCompactFailures = source.consecutiveCompactFailures;
  target.turnsSinceLast = source.turnsSinceLast;
  target.lastAutoCompactAttemptTurnId = source.lastAutoCompactAttemptTurnId;
}
