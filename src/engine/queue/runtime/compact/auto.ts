import { findModel } from "@/engine/model/catalog.ts";
import { QuotaExhaustedError } from "@/engine/providers/_shared/retry.ts";
import * as providers from "@/engine/providers/registry.ts";
import { currentLocalISODate } from "@/engine/queue/runtime/turn-prompts.ts";
import { pruneContentReplacementStateForSession } from "@/engine/session/compact/content-replacement-prune.ts";
import { groupByApiRound } from "@/engine/session/compact/grouping.ts";
import {
  AUTOCOMPACT_RAPID_REFILL_ERROR_MESSAGE,
  getModelAutoCompactThreshold,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
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
import {
  formatCompactSummary,
  getCompactUserSummaryMessage,
} from "@/harness/routines/compact/index.ts";
import { fireConfiguredHooks } from "@/kernel/hooks/handler.ts";
import { AsyncStream } from "@/kernel/std/stream/async.ts";
import type { AgentEvent, ProviderEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { checkContextOverflow } from "./overflow.ts";
import {
  type CompactOrchestrationDeps,
  computeUsedContextTokens,
  resolveCompactWindow,
  splitPreservedTail,
} from "./support.ts";

interface PeeledSummary {
  summary: string;
  droppedMessages: number;
  preservedTail: Message[];
}

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
  if (process.env.DISABLE_COMPACT || process.env.DISABLE_AUTO_COMPACT) return;
  if (deps.state.circuitOpen) {
    // Re-arm once the context refilled slowly (past the rapid threshold). Left
    // permanently open, the failure circuit disables auto-compaction for the
    // rest of the session, so session.messages grows unbounded — the same
    // failure mode the rapid-refill breaker below guards against. A genuine
    // repeat failure just re-trips it.
    if (deps.state.turnsSinceLast < RAPID_REFILL_TURN_THRESHOLD) return;
    deps.state.circuitOpen = false;
    deps.state.consecutiveFailures = 0;
  }
  if (deps.state.rapidRefillBreakerOpen) {
    // Re-arm once the context refilled slowly (past the rapid threshold). Left
    // permanently open, the breaker disables auto-compaction for the rest of the
    // session, so session.messages — including resident image base64 that no
    // other bound trims — grows unbounded. A genuine thrash just re-trips it.
    if (deps.state.turnsSinceLast < RAPID_REFILL_TURN_THRESHOLD) return;
    deps.state.rapidRefillBreakerOpen = false;
    deps.state.rapidRefillCount = 0;
  }
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
  if (deps.state.turnsSinceLast < RAPID_REFILL_TURN_THRESHOLD) {
    deps.state.rapidRefillCount += 1;
  } else {
    deps.state.rapidRefillCount = 0;
  }
  if (deps.state.rapidRefillCount >= MAX_CONSECUTIVE_RAPID_REFILLS) {
    deps.state.rapidRefillBreakerOpen = true;
    deps.agentDeps.session.messages.push({
      role: "assistant",
      content: [{ type: "text", text: AUTOCOMPACT_RAPID_REFILL_ERROR_MESSAGE }],
    });
    await appendRecord(deps.agentDeps.session, {
      type: "compaction_mark",
      ts: nowIso(),
      summary_ref: "",
      provider: state.provider,
      model: state.model,
      version: 1,
      preTokens: used,
      trigger: "rapid_refill_trip",
      error: AUTOCOMPACT_RAPID_REFILL_ERROR_MESSAGE,
      rapidRefillCount: deps.state.rapidRefillCount,
    });
    yield {
      kind: "compact_done",
      mode: "failed",
      droppedMessages: 0,
      truncatedMessages: 0,
      preTokens: used,
      durationMs: 0,
      error: AUTOCOMPACT_RAPID_REFILL_ERROR_MESSAGE,
    };
    yield { kind: "error", error: AUTOCOMPACT_RAPID_REFILL_ERROR_MESSAGE };
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
  const turn = assembleProviderTurn({
    ctx,
    provider,
    messages: deps.agentDeps.session.messages,
    injections: deps.injections,
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
  try {
    for await (const ev of queue.iterate(() => summarizeSettled)) {
      if (ev.kind === "retry_status") yield ev;
      else if (ev.kind === "quota_exhausted") yield ev;
    }
    const result = await summarizePromise;
    const formatted = formatCompactSummary(result.summary);
    if (!formatted || formatted === "Summary:" || formatted.length < 50) {
      console.warn("Warning: Auto-compaction failed. Generated summary is empty or too short.");
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
    readSetClearExcept(
      MAIN_SCOPE,
      restoredFiles.map((file) => file.path),
    );
    deps.clearNestedMemory?.();
    const newAutoMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: summaryMessage }] },
    ];
    if (rehydrationBlocks.length > 0) {
      newAutoMessages.push({ role: "user", content: rehydrationBlocks });
    }
    newAutoMessages.push(...preservedTail);
    const beforeAutoTokens = estimateTokens(deps.agentDeps.session.messages);
    deps.agentDeps.session.messages.splice(
      0,
      deps.agentDeps.session.messages.length,
      ...newAutoMessages,
    );
    clearLastUsage();
    pruneContentReplacementStateForSession(deps.agentDeps.session);
    await fireConfiguredHooks(deps.agentDeps.config, "postCompact", {
      kind: "postCompact",
      ctx: {
        sessionId: deps.agentDeps.session.id,
        transcriptPath,
        trigger: "auto",
      },
    });
    await appendRecord(deps.agentDeps.session, {
      type: "compaction_mark",
      ts: nowIso(),
      summary_ref: result.summary,
      provider: state.provider,
      model: state.model,
      version: 1,
      preTokens: beforeAutoTokens,
      trigger: "auto",
      ...(preservedImages.length > 0 ? { preservedImages } : {}),
    });
    const compactBoundaryIdx = deps.agentDeps.session.records.findLastIndex(
      (r) => r.type === "compaction_mark",
    );
    if (compactBoundaryIdx > 0) {
      deps.agentDeps.session.records.splice(0, compactBoundaryIdx);
    }
    deps.state.consecutiveFailures = 0;
    deps.state.turnsSinceLast = 0;
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
    if (err instanceof QuotaExhaustedError) {
      return;
    }
    if (ctx.abortSignal?.aborted === true) {
      yield {
        kind: "compact_done",
        mode: "failed",
        droppedMessages: 0,
        truncatedMessages: 0,
        preTokens: used,
        durationMs: Date.now() - start,
        error: "compaction cancelled",
      };
      return;
    }
    deps.state.consecutiveFailures += 1;
    if (deps.state.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      deps.state.circuitOpen = true;
    }
    const reason = err instanceof Error ? err.message : String(err);
    if (checkContextOverflow(deps)?.kind !== "prefix") {
      deps.injections.push(
        `(auto-compact failed: ${reason}. ${deps.state.circuitOpen ? "Circuit breaker tripped — auto-compact disabled for this session." : `Attempt ${deps.state.consecutiveFailures}/${MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES}.`})`,
      );
    }
    await appendRecord(deps.agentDeps.session, {
      type: "compaction_mark",
      ts: nowIso(),
      summary_ref: "",
      provider: state.provider,
      model: state.model,
      version: 1,
      preTokens: used,
      trigger: deps.state.circuitOpen ? "circuit_breaker_trip" : "auto_failure",
      error: reason,
      consecutiveFailures: deps.state.consecutiveFailures,
    });
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
