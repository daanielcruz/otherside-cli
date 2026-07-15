import { findModel } from "@/engine/model/catalog.ts";
import * as providers from "@/engine/providers/registry.ts";
import { currentLocalISODate } from "@/engine/queue/runtime/turn-prompts.ts";
import { pruneContentReplacementStateForSession } from "@/engine/session/compact/content-replacement-prune.ts";
import {
  getModelAutoCompactThreshold,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  maxOutputTokensForModel,
} from "@/engine/session/compact/index.ts";
import { clearLastUsage } from "@/engine/session/compact/last-usage.ts";
import {
  buildPostCompactRehydration,
  collectImageBlocks,
  POST_COMPACT_MAX_IMAGES,
  type RestoredFile,
} from "@/engine/session/compact/rehydration.ts";
import { summarizeConversation } from "@/engine/session/compact/summary.ts";
import { estimateTokens } from "@/engine/session/compact/token-count.ts";
import { appendRecord, nowIso, sessionPathForCwd } from "@/engine/session/index.ts";
import { MAIN_SCOPE, readSetClearExcept } from "@/engine/tools/builtins/read/state.ts";
import { assembleProviderTurn } from "@/engine/translator/index.ts";
import {
  formatCompactSummary,
  getCompactUserSummaryMessage,
} from "@/harness/routines/compact/index.ts";
import { fireConfiguredHooks } from "@/kernel/hooks/handler.ts";
import { AsyncStream } from "@/kernel/std/stream/async.ts";
import type { AgentEvent, ProviderEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { type CompactOrchestrationDeps, resolveCompactWindow } from "./support.ts";

export interface ForceCompactOptions {
  customInstructions?: string;
  onEvent?: (ev: ProviderEvent) => void;
  onCompactStart?: (info: { preTokens: number }) => void;
  onCompactDone?: (info: {
    mode: "summary" | "failed";
    durationMs: number;
    truncatedMessages: number;
    preTokens: number;
    summary?: string;
    error?: string;
    // True only for a genuine abort (the compact's own controller was aborted,
    // e.g. user Esc). Absent for other onCompactDone call sites that never
    // abort a controller, so downstream text falls back to message sniffing.
    cancelled?: boolean;
    restoredFiles?: RestoredFile[];
  }) => void;
}

export interface ForceCompactResult {
  dropped: number;
  truncated: number;
  summary: string;
  durationMs: number;
}

type CompactSummary = Awaited<ReturnType<typeof summarizeConversation>>;

interface CompactRun {
  ctx: RequestContext;
  controller: AbortController;
  start: number;
  preTokens: number;
  transcriptPath: string;
  before: number;
}

export async function forceCompact(
  deps: CompactOrchestrationDeps,
  opts?: ForceCompactOptions,
): Promise<ForceCompactResult> {
  const before = deps.agentDeps.session.messages.length;
  if (before === 0) return { dropped: 0, truncated: 0, summary: "", durationMs: 0 };
  const run = beginCompact(deps, opts, before);
  await fireConfiguredHooks(deps.agentDeps.config, "preCompact", {
    kind: "preCompact",
    ctx: {
      sessionId: deps.agentDeps.session.id,
      transcriptPath: run.transcriptPath,
      trigger: "manual",
      ...(opts?.customInstructions ? { customInstructions: opts.customInstructions } : {}),
    },
  });
  const result = await summarizeForCompact(deps, run, opts);
  return applyCompactSummary(deps, run, result, opts);
}

function beginCompact(
  deps: CompactOrchestrationDeps,
  opts: ForceCompactOptions | undefined,
  before: number,
): CompactRun {
  const ctx = deps.makeCtx();
  const controller = new AbortController();
  ctx.abortSignal = controller.signal;
  deps.setActiveAbortController(controller);
  const start = Date.now();
  const preTokens = estimateTokens(deps.agentDeps.session.messages);
  opts?.onCompactStart?.({ preTokens });
  const transcriptPath = sessionPathForCwd(
    deps.agentDeps.session.storageCwd,
    deps.agentDeps.session.id,
  );
  return { ctx, controller, start, preTokens, transcriptPath, before };
}

async function summarizeForCompact(
  deps: CompactOrchestrationDeps,
  run: CompactRun,
  opts: ForceCompactOptions | undefined,
): Promise<CompactSummary> {
  try {
    const provider = providers.get(run.ctx.provider);
    const turn = assembleProviderTurn({
      ctx: run.ctx,
      provider,
      messages: deps.agentDeps.session.messages,
      injections: deps.injections,
      config: deps.agentDeps.config,
      currentDate: currentLocalISODate(),
    });
    // Pass the real agent harness so the summary request reuses the conversation
    // prompt-cache prefix (system + tools) instead of a summarizer-only system.
    return await summarizeConversation(
      run.ctx,
      deps.agentDeps.session.messages,
      turn.tools,
      opts?.customInstructions,
      opts?.onEvent,
      turn.harness,
    );
  } catch (err) {
    deps.state.consecutiveFailures += 1;
    if (deps.state.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      deps.state.circuitOpen = true;
    }
    opts?.onCompactDone?.({
      mode: "failed",
      durationMs: Date.now() - run.start,
      truncatedMessages: 0,
      preTokens: run.preTokens,
      error: err instanceof Error ? err.message : String(err),
      cancelled: run.controller.signal.aborted,
    });
    throw err;
  } finally {
    if (deps.activeAbortController() === run.controller) deps.setActiveAbortController(null);
  }
}

async function applyCompactSummary(
  deps: CompactOrchestrationDeps,
  run: CompactRun,
  result: CompactSummary,
  opts: ForceCompactOptions | undefined,
): Promise<ForceCompactResult> {
  const formatted = formatCompactSummary(result.summary);
  if (!formatted || formatted === "Summary:" || formatted.length < 50) {
    const errorMsg = "Compaction failed: generated summary is empty or too short.";
    opts?.onCompactDone?.({
      mode: "failed",
      durationMs: Date.now() - run.start,
      truncatedMessages: 0,
      preTokens: run.preTokens,
      error: errorMsg,
    });
    console.error(errorMsg);
    throw new Error(errorMsg);
  }
  deps.state.consecutiveFailures = 0;
  deps.state.circuitOpen = false;
  deps.state.rapidRefillCount = 0;
  deps.state.rapidRefillBreakerOpen = false;
  deps.state.turnsSinceLast = 0;
  const summaryMessage = getCompactUserSummaryMessage(result.summary, {
    transcriptPath: run.transcriptPath,
  });
  const compactBrokerState = deps.agentDeps.broker.read();
  const preservedImages = collectImageBlocks(deps.agentDeps.session.messages).slice(
    -POST_COMPACT_MAX_IMAGES,
  );
  const { blocks: rehydrationBlocks, restoredFiles } = buildPostCompactRehydration(
    compactBrokerState.permissionMode,
    preservedImages,
  );
  readSetClearExcept(
    MAIN_SCOPE,
    restoredFiles.map((file) => file.path),
  );
  deps.clearNestedMemory?.();
  const newMessages: Message[] = [
    { role: "user", content: [{ type: "text", text: summaryMessage }] },
  ];
  if (rehydrationBlocks.length > 0) {
    newMessages.push({ role: "user", content: rehydrationBlocks });
  }
  const beforeTokens = estimateTokens(deps.agentDeps.session.messages);
  deps.agentDeps.session.messages.splice(0, deps.agentDeps.session.messages.length, ...newMessages);
  clearLastUsage();
  await appendRecord(deps.agentDeps.session, {
    type: "compaction_mark",
    ts: nowIso(),
    summary_ref: result.summary,
    provider: compactBrokerState.provider,
    model: compactBrokerState.model,
    version: 1,
    preTokens: beforeTokens,
    trigger: "manual",
    ...(preservedImages.length > 0 ? { preservedImages } : {}),
  });
  const compactBoundaryIdx = deps.agentDeps.session.records.findLastIndex(
    (r) => r.type === "compaction_mark",
  );
  if (compactBoundaryIdx > 0) {
    deps.agentDeps.session.records.splice(0, compactBoundaryIdx);
  }
  pruneContentReplacementStateForSession(deps.agentDeps.session);
  await fireConfiguredHooks(deps.agentDeps.config, "postCompact", {
    kind: "postCompact",
    ctx: {
      sessionId: deps.agentDeps.session.id,
      transcriptPath: run.transcriptPath,
      trigger: "manual",
    },
  });
  providers.get(run.ctx.provider).onCompactionSucceeded?.(run.ctx);
  const durationMs = Date.now() - run.start;
  opts?.onCompactDone?.({
    mode: "summary",
    durationMs,
    truncatedMessages: result.droppedMessages,
    preTokens: run.preTokens,
    summary: result.summary,
    restoredFiles,
  });
  return {
    dropped: run.before,
    truncated: result.droppedMessages,
    summary: result.summary,
    durationMs,
  };
}

export async function* forceCompactOnOverflow(
  deps: CompactOrchestrationDeps,
): AsyncIterable<AgentEvent> {
  if (deps.agentDeps.session.messages.length === 0) return;
  const state = deps.agentDeps.broker.read();
  const model = findModel(state.model);
  const window = model ? resolveCompactWindow(model) : 0;
  const maxOutput = maxOutputTokensForModel(state.model);
  const threshold = model
    ? getModelAutoCompactThreshold({
        model,
        window,
        maxOutputTokens: maxOutput,
        provider: state.provider,
      })
    : 0;
  const preTokens = estimateTokens(deps.agentDeps.session.messages);
  yield { kind: "compact_start", preTokens, threshold, window };
  const queue = new AsyncStream<ProviderEvent>();
  let settled = false;
  const compactPromise = forceCompact(deps, {
    onEvent: (ev) => queue.push(ev),
  }).finally(() => {
    settled = true;
    queue.signal();
  });
  compactPromise.catch(() => {});
  for await (const ev of queue.iterate(() => settled)) {
    if (ev.kind === "retry_status" || ev.kind === "quota_exhausted") yield ev;
  }
  try {
    const result = await compactPromise;
    yield {
      kind: "compact_done",
      mode: "summary",
      droppedMessages: result.dropped,
      truncatedMessages: result.truncated,
      preTokens,
      durationMs: result.durationMs,
      summary: result.summary,
    };
  } catch (err) {
    yield {
      kind: "compact_done",
      mode: "failed",
      droppedMessages: 0,
      truncatedMessages: 0,
      preTokens,
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
