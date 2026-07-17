import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  resolveWorkflowAgentProfile,
  runForkLoopExternal,
  type SubagentResult,
} from "@/engine/background/subagents/dispatcher.ts";
import { resolveToolModelOverride } from "@/engine/background/subagents/fork/routing.ts";
import { clampNestedTier } from "@/engine/background/subagents/fork/tier-ceiling.ts";
import {
  acquireWorktreeLease,
  createWorktree,
  type Worktree,
  type WorktreeLease,
} from "@/engine/background/subagents/worktree.ts";
import type {
  WorkflowBudgetState,
  WorkflowTokenMeter,
} from "@/engine/background/workflows/runtime/budget/budget.ts";
import { enforceWorkflowBudget } from "@/engine/background/workflows/runtime/budget/errors.ts";
import type {
  WorkflowJournalEntry,
  WorkflowJournalResultEntry,
  WorkflowJournalStartedEntry,
} from "@/engine/background/workflows/runtime/history/journal.ts";
import { cloneWorkflowBoundaryValue } from "@/engine/background/workflows/runtime/sandbox/clone.ts";
import { buildVmSafeError } from "@/engine/background/workflows/runtime/sandbox/errors.ts";
import {
  getRunningWorkflowByRunId,
  updateWorkflowTask,
} from "@/engine/background/workflows/runtime/store/store.ts";
import {
  WORKFLOW_AGENT_RETRY_REASON,
  WORKFLOW_AGENT_SKIP_REASON,
} from "@/engine/background/workflows/runtime/store/types.ts";
import { createAgentTranscriptStore } from "@/engine/background/workflows/runtime/transcript/store.ts";
import type { AgentTranscript } from "@/engine/background/workflows/runtime/transcript/types.ts";
import { findModel } from "@/engine/model/catalog.ts";
import {
  type ModelFallbackDeviation,
  rankOneCooldownDeviation,
  resolveWithModelFallbackDecision,
  routingNoticeForDeviation,
} from "@/engine/model/facts/model-fallback-decision.ts";
import { exhaustedProviderLaunchError, resolveModelPin } from "@/engine/model/facts/model-pin.ts";
import { defaultTierForAgentType } from "@/engine/model/tier/agent-defaults.ts";
import { isTierName } from "@/engine/model/tier/names.ts";
import {
  isProviderUsableNow,
  isQuotaDisplacedCandidate,
  quotaDisplacedBeforeTopNSelection,
  resolveTierTopNWithCascadeDetailed,
  type TierCandidateDetail,
  type TierResolution,
  tierModelCandidateNow,
  usableActiveProviderForTierResolution,
} from "@/engine/model/tier/resolver.ts";
import { currentProviderPlan } from "@/engine/providers/_shared/plan.ts";
import type { OrchestrationMode } from "@/kernel/config/orchestration-mode.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { errorMessage } from "@/kernel/std/errno.ts";
import type { ForkEventSink } from "@/kernel/std/types/events.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { computeAgentCacheKey } from "./agent-cache-key.ts";
import { deriveAgentLabel, truncateWorkflowPreview } from "./agent-display.ts";
import { isPlainObject, readAgentOptions } from "./agent-options.ts";
import {
  computeWorkflowCpuCount,
  createConcurrencyGate,
  workflowConcurrencyLimit,
} from "./concurrency.ts";
import {
  runForkWithRetries,
  type WorkflowForkRequest,
  type WorkflowForkRunner,
} from "./fork-retries.ts";

export const WORKFLOW_MAX_AGENTS = 1000;
export const WORKFLOW_MAX_PARALLEL_ITEMS = 4096;
const WORKFLOW_PARENT_ABORT_REASON = "workflow-abort";
const WORKFLOW_MAX_USER_RETRIES = 100;

interface CacheReplayState {
  exhausted: boolean;
  prevKey: string;
  callIndex: number;
}

interface CacheExecutionScope {
  path: string;
  chain: CacheReplayState;
  operationIndex: number;
}

function mergeCacheBranchKeys(path: string, prevKey: string, branchKeys: string[]): string {
  const digest = createHash("sha256")
    .update("workflow-cache-branches\0")
    .update(path)
    .update("\0")
    .update(prevKey)
    .update("\0")
    .update(JSON.stringify(branchKeys))
    .digest("hex");
  return `branch:${digest}`;
}

function sleepUntilWorkflowFallback(untilEpochMs: number, signal: AbortSignal): Promise<void> {
  const delayMs = Math.max(0, untilEpochMs - Date.now());
  if (delayMs === 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(buildVmSafeError("Workflow was aborted."));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(buildVmSafeError("Workflow was aborted."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface WorkflowAgentEvent {
  index: number;
  label: string;
  phaseTitle?: string;
  // Resolved routing provider — the allocation signal for passive quota
  // warnings (model is the display name, not a routing key).
  provider?: ProviderId;
  model?: string;
  agentType?: string;
  isolation?: "worktree";
  attempt?: number;
  lastAttemptReason?: "throttled" | "stalled";
  state: "start" | "done" | "error";
  cached?: boolean;
  skipped?: boolean;
  stopped?: boolean;
  agentId?: string;
  prompt?: string;
  transcript?: AgentTranscript;
  resultPreview?: string;
  lastToolName?: string;
  lastToolSummary?: string;
  tokens?: number;
  totalTokens?: number;
}

export interface WorkflowSubagentBridgeOptions {
  ctx: RequestContext;
  parentToolCallId: string;
  runId: string;
  signal: AbortSignal;
  onAgentEvent?: (event: WorkflowAgentEvent) => void;
  onAgentController?: (agentId: string, controller: AbortController | null) => void;
  recordFailure?: (message: string) => void;
  /** Progress/log channel for non-failure notices (e.g. resume respawns). */
  log?: (message: string) => void;
  getCurrentPhase?: () => string | undefined;
  runFork?: WorkflowForkRunner;
  meter?: WorkflowTokenMeter;
  budget?: WorkflowBudgetState;
  journal?: {
    append: (entry: WorkflowJournalEntry) => Promise<void>;
    results: Map<string, WorkflowJournalResultEntry>;
    started: Map<string, WorkflowJournalStartedEntry[]>;
  };
}

const defaultForkRunner: WorkflowForkRunner = (request) =>
  runForkLoopExternal({
    ctx: request.ctx,
    name: request.name,
    body: request.body,
    allowSet: request.allowSet,
    prompt: request.prompt,
    parentToolCallId: request.parentToolCallId,
    agentId: request.agentId,
    extraDeclarations: request.extraDeclarations,
    ...(request.outputSchema !== undefined ? { outputSchema: request.outputSchema } : {}),
    ...(request.sink !== undefined ? { sink: request.sink } : {}),
    ...(request.isolation !== undefined ? { isolation: request.isolation } : {}),
    ...(request.worktreeKey !== undefined ? { worktreeKey: request.worktreeKey } : {}),
    ...(request.worktree !== undefined ? { worktree: request.worktree } : {}),
  });

let forkRunnerOverride: WorkflowForkRunner | null = null;

export function setWorkflowForkRunnerForTests(runner: WorkflowForkRunner | null): void {
  forkRunnerOverride = runner;
}

export interface WorkflowSubagentBridge {
  agent: (prompt: unknown, options?: unknown) => Promise<unknown>;
  parallel: (thunks: unknown) => Promise<unknown[]>;
  pipeline: (items: unknown, ...stages: unknown[]) => Promise<unknown[]>;
  agentCount: () => number;
}

export interface WorkflowAgentModelContextDetail {
  ok: boolean;
  ctx: RequestContext;
  error?: string;
  degradedReasons?: string[];
  fallbackDeviation?: ModelFallbackDeviation;
  /** The resolved tier pool (top-1 or top-3), so the run can pin it across agents. */
  selectedPool?: TierResolution[];
}

const DIVERSIFY_PROVIDER_SPREAD = 3;
const BEST_OF_TIER_SPREAD = 1;

function orchestrationModeOf(ctx: RequestContext): OrchestrationMode {
  return ctx.orchestrationMode ?? "disabled";
}

function workflowOrchestrationOptionError(
  ctx: RequestContext,
  opts: Pick<ReturnType<typeof readAgentOptions>, "provider" | "model" | "tier" | "diversify">,
): string | undefined {
  const mode = orchestrationModeOf(ctx);
  if (mode === "disabled") {
    if (opts.provider !== undefined) {
      return "InputValidationError: `provider` is unavailable when orchestration is disabled. Use `model` with the active provider.";
    }
    if (opts.tier !== undefined) {
      return "InputValidationError: `tier` is unavailable when orchestration is disabled. Use `model` with the active provider.";
    }
    if (opts.diversify !== undefined) {
      return "InputValidationError: `diversify` is available only in feudalism mode.";
    }
  }
  if (mode === "default") {
    if (opts.tier !== undefined) {
      return "InputValidationError: `tier` is unavailable in Default mode. Use concrete `provider` + `model` pins or omit overrides.";
    }
    if (opts.diversify !== undefined) {
      return "InputValidationError: `diversify` is unavailable in Default mode. Use concrete `provider` + `model` pins or omit overrides.";
    }
  }
  if (mode === "feudalism" && (opts.provider !== undefined || opts.model !== undefined)) {
    return "InputValidationError: concrete `provider`/`model` pins are unavailable in feudalism mode. Use `tier` routing instead.";
  }
  return undefined;
}

function workflowQuotaFallbackDisabledError(tier: string, skipped: TierCandidateDetail): string {
  return `Quota fallback is disabled: tier "${tier}" would reroute past ${skipped.provider}/${skipped.model}, which is quota-blocked (${skipped.blockedReasons.join("; ")}). The agent fails instead of rerouting. Enable "Quota fallback" in /config or retry after the quota resets.`;
}

export function resolveWorkflowAgentModelContextDetailed(
  ctx: RequestContext,
  opts: Pick<ReturnType<typeof readAgentOptions>, "tier" | "diversify">,
  poolState?: { allocationCount: number },
  pinnedPool?: TierResolution[],
): WorkflowAgentModelContextDetail {
  const optionError = workflowOrchestrationOptionError(ctx, opts);
  if (optionError !== undefined) return { ok: false, ctx, error: optionError };
  const tierClamp =
    orchestrationModeOf(ctx) === "feudalism" && opts.tier !== undefined && isTierName(opts.tier)
      ? clampNestedTier(ctx, opts.tier)
      : undefined;
  const tier = tierClamp?.tier ?? opts.tier;
  if (tier !== undefined) {
    if (orchestrationModeOf(ctx) !== "feudalism") {
      return {
        ok: false,
        ctx,
        error:
          "InputValidationError: `tier` selection requires feudalism mode. Enable feudalism in /config.",
      };
    }
    if (!isTierName(tier)) {
      return {
        ok: false,
        ctx,
        error: "InputValidationError: tier must be one of: emperor, shogun, daimyo, samurai.",
      };
    }

    // When the caller's own usable model already belongs to the tier it is routing
    // to, inherit it rather than escalating to top-1. The caller is the active
    // session provider, so it keeps its usage/balance exemption and only a real
    // cooldown routes through the tier roster so rank 2 can carry it.
    const shouldDiversify = !!opts.diversify;
    if (!shouldDiversify) {
      const callerCandidate = tierModelCandidateNow(tier, ctx.provider, ctx.model, ctx.provider);
      if (callerCandidate?.usable) {
        return tierClamp === undefined
          ? { ok: true, ctx }
          : { ok: true, ctx, degradedReasons: [tierClamp.notice] };
      }
      // Same contract as the fork path: the caller's own tier model losing its
      // slot to quota (e.g. a spent model-scoped window) is a quota reroute.
      if (
        ctx.quotaFallbackEnabled === false &&
        callerCandidate !== null &&
        isQuotaDisplacedCandidate(callerCandidate)
      ) {
        return {
          ok: false,
          ctx,
          error: workflowQuotaFallbackDisabledError(tier, callerCandidate),
        };
      }
    }

    // Spread across the distinct providers of the tier (internal rank/top-N
    // mechanism), round-robin by allocation index. diversify on → top-3 distinct
    // providers (for tasks where divergent opinions pay); off → top-1, so every
    // agent runs on the one best model of the tier. <count usable degrades to
    // what's there rather than erroring.
    const count = shouldDiversify ? DIVERSIFY_PROVIDER_SPREAD : BEST_OF_TIER_SPREAD;
    const activeProvider = usableActiveProviderForTierResolution(ctx.provider);
    const degradedReasons: string[] = [];
    if (tierClamp !== undefined) degradedReasons.push(tierClamp.notice);

    // Keep the run's usable pinned members stable; drop members that the current
    // quota SoT blocks, and re-resolve only when none remain.
    let pool: TierResolution[] | null = pinnedPool && pinnedPool.length > 0 ? pinnedPool : null;
    if (pool) {
      const usablePool = pool.filter((entry) =>
        isProviderUsableNow(entry.provider, activeProvider, entry.model),
      );
      pool = usablePool.length > 0 ? usablePool : null;
    }
    let fallbackDeviation: ModelFallbackDeviation | undefined;
    if (pool === null) {
      const detailed = resolveTierTopNWithCascadeDetailed(tier, count, undefined, activeProvider);
      if (ctx.quotaFallbackEnabled === false) {
        const displaced = quotaDisplacedBeforeTopNSelection(detailed);
        if (displaced !== null) {
          return {
            ok: false,
            ctx,
            error: workflowQuotaFallbackDisabledError(tier, displaced),
          };
        }
      }
      if (detailed.selected.length === 0) {
        if (isProviderUsableNow(ctx.provider, ctx.provider, ctx.model)) {
          degradedReasons.push(
            `No usable provider found in tier cascade "${tier}"; using the active route ${ctx.provider}/${ctx.model}. Diagnostics: ${detailed.error ?? "none"}`,
          );
          return { ok: true, ctx, degradedReasons };
        }
        return {
          ok: false,
          ctx,
          error: `No usable provider found in tier cascade "${tier}". Diagnostics: ${detailed.error ?? "none"}`,
        };
      }
      pool = detailed.resolutions;
      if (detailed.selectedTier !== null && detailed.selectedTier !== tier) {
        degradedReasons.push(
          `Tier "${tier}" unavailable; using lower tier "${detailed.selectedTier}".`,
        );
      }
      fallbackDeviation =
        rankOneCooldownDeviation(
          tier,
          detailed.tiers.flatMap((entry) => entry.candidates),
          detailed.selected[0],
        ) ?? undefined;
      if (fallbackDeviation !== undefined) {
        degradedReasons.push(routingNoticeForDeviation(fallbackDeviation));
      }
      const selectedTierDetail = detailed.tiers.find((t) => t.tier === detailed.selectedTier);
      if (selectedTierDetail) {
        const totalCandidates = selectedTierDetail.candidates.length;
        if (detailed.selected.length < totalCandidates) {
          degradedReasons.push(
            `Fewer workers/providers available for tier "${tier}": ${detailed.selected.length}/${totalCandidates} usable.`,
          );
        }
      }
    }

    const allocationIndex = poolState ? poolState.allocationCount : 0;
    const selected = pool[allocationIndex % pool.length]!;
    const res: WorkflowAgentModelContextDetail = {
      ok: true,
      ctx: { ...ctx, provider: selected.provider, model: selected.model },
      selectedPool: pool,
    };
    if (degradedReasons.length > 0) res.degradedReasons = degradedReasons;
    if (fallbackDeviation !== undefined) res.fallbackDeviation = fallbackDeviation;
    return res;
  }

  // No tier selection — the agent inherits the parent's model and provider.
  const error = exhaustedProviderLaunchError(
    ctx.provider,
    ctx.provider,
    ctx.model,
    orchestrationModeOf(ctx),
  );
  return error === null ? { ok: true, ctx } : { ok: false, ctx, error };
}

export function resolveWorkflowAgentModelContext(
  ctx: RequestContext,
  opts: Pick<ReturnType<typeof readAgentOptions>, "tier">,
): { ok: true; ctx: RequestContext } | { ok: false; error: string } {
  const detailed = resolveWorkflowAgentModelContextDetailed(ctx, opts);
  if (!detailed.ok) {
    return { ok: false, error: detailed.error ?? "unknown error" };
  }
  return { ok: true, ctx: detailed.ctx };
}

// An explicit tier wins; otherwise, in tiering mode, a named agentType infers
// its tier (explore→daimyo, plan→emperor, …; inference never picks samurai).
// Other modes inherit the parent model unless they receive a concrete pin.
export function resolveEffectiveTier(
  ctx: RequestContext,
  opts: Pick<ReturnType<typeof readAgentOptions>, "tier" | "agentType">,
): string | undefined {
  if (opts.tier !== undefined) return opts.tier;
  if (orchestrationModeOf(ctx) === "feudalism" && opts.agentType !== undefined) {
    return defaultTierForAgentType(opts.agentType);
  }
  return undefined;
}

export async function createWorkflowSubagentBridge(
  options: WorkflowSubagentBridgeOptions,
): Promise<WorkflowSubagentBridge> {
  let agentSeq = 0;
  const rootCacheScope: CacheExecutionScope = {
    path: "root",
    chain: { exhausted: false, prevKey: "", callIndex: 0 },
    operationIndex: 0,
  };
  const cacheScopeStorage = new AsyncLocalStorage<CacheExecutionScope>();
  const transcripts = createAgentTranscriptStore();
  const tierAllocationCounts: Record<string, number> = {};
  const tierPinnedPools: Record<string, TierResolution[]> = {};

  // Sampled once for the whole run so the machine-scaled default (see
  // concurrency.ts) doesn't drift if it were re-read per provider pool.
  const cpuCount = computeWorkflowCpuCount();

  // One concurrency pool per RESOLVED provider — every agent obeys its own
  // provider's limit, so a low-limit provider never throttles a fast sibling.
  const gate = createConcurrencyGate({
    limitFor: async (provider) =>
      workflowConcurrencyLimit(provider, await currentProviderPlan(provider), cpuCount),
  });

  const activeCacheScope = (): CacheExecutionScope =>
    cacheScopeStorage.getStore() ?? rootCacheScope;

  const runCacheReplayBatch = async <Item, Result>(
    kind: "parallel" | "pipeline",
    identity: string,
    items: readonly Item[],
    runItem: (item: Item, index: number) => Promise<Result>,
  ): Promise<Result[]> => {
    const parent = activeCacheScope();
    const operationIndex = parent.operationIndex;
    parent.operationIndex += 1;
    const operationPath = `${parent.path}/${kind}:${operationIndex}:${identity}`;
    const parentPrevKey = parent.chain.prevKey;
    const scopes = items.map<CacheExecutionScope>((_, index) => ({
      path: `${operationPath}/item:${index}`,
      chain: {
        exhausted: parent.chain.exhausted,
        prevKey: parentPrevKey,
        callIndex: 0,
      },
      operationIndex: 0,
    }));
    const results = await Promise.all(
      items.map((item, index) => cacheScopeStorage.run(scopes[index]!, () => runItem(item, index))),
    );
    parent.chain.exhausted ||= scopes.some((scope) => scope.chain.exhausted);
    parent.chain.prevKey = mergeCacheBranchKeys(
      operationPath,
      parentPrevKey,
      scopes.map((scope) => scope.chain.prevKey),
    );
    return results;
  };

  const runAgent = async (prompt: unknown, rawOptions?: unknown): Promise<unknown> => {
    if (options.signal.aborted) throw buildVmSafeError("Workflow was aborted.");
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw buildVmSafeError("agent() requires a non-empty prompt string.");
    }
    if (options.budget) enforceWorkflowBudget(options.budget);
    agentSeq += 1;
    if (agentSeq > WORKFLOW_MAX_AGENTS) {
      throw buildVmSafeError(`Workflow exceeded the ${WORKFLOW_MAX_AGENTS}-agent cap.`);
    }
    const index = agentSeq;
    const opts = readAgentOptions(rawOptions);
    const phaseTitle = opts.phase ?? options.getCurrentPhase?.();
    const label = opts.label ?? deriveAgentLabel(prompt, phaseTitle, index);
    const agentId = `workflow-${options.runId}-${index}`;
    // Reserve identity synchronously, before provider resolution can yield. This
    // keeps even concurrently-created calls deterministic; combinators add their
    // branch/item/stage path through AsyncLocalStorage.
    const cacheScope = activeCacheScope();
    const structuralPath = `${cacheScope.path}/agent:${cacheScope.chain.callIndex}`;
    cacheScope.chain.callIndex += 1;
    const baseCtx: RequestContext = {
      ...options.ctx,
      abortSignal: options.signal,
    };
    const optionError = workflowOrchestrationOptionError(baseCtx, opts);
    // An explicit (provider, model) pin is literal in Default mode. Experimental
    // mode has no concrete pin path; tier routing owns the selection there.
    const explicitPin =
      opts.provider === undefined
        ? null
        : opts.model === undefined
          ? ({
              ok: false,
              error: "InputValidationError: `provider` requires `model` to name the pinned model.",
            } as const)
          : resolveModelPin(
              opts.provider,
              opts.model,
              baseCtx.provider,
              orchestrationModeOf(baseCtx),
            );
    const explicitModel =
      opts.provider === undefined && opts.model !== undefined
        ? resolveToolModelOverride(baseCtx, opts.model)
        : null;
    const effectiveTier =
      optionError === undefined && explicitPin === null && explicitModel === null
        ? resolveEffectiveTier(baseCtx, opts)
        : undefined;
    const effectiveDiversify = optionError === undefined ? opts.diversify : undefined;
    const cacheKey = options.journal
      ? computeAgentCacheKey(
          prompt,
          rawOptions,
          structuralPath,
          cacheScope.chain.prevKey,
          orchestrationModeOf(baseCtx),
        )
      : undefined;
    if (cacheKey !== undefined) cacheScope.chain.prevKey = cacheKey;
    const poolKey =
      effectiveTier !== undefined ? `${effectiveTier}:${effectiveDiversify ? "d" : "1"}` : "";
    let allocationCount = 0;
    if (poolKey) {
      allocationCount = tierAllocationCounts[poolKey] ?? 0;
      tierAllocationCounts[poolKey] = allocationCount + 1;
    }
    const resolveContext = (): WorkflowAgentModelContextDetail => {
      if (optionError !== undefined) return { ok: false, ctx: baseCtx, error: optionError };
      if (explicitPin !== null) {
        return explicitPin.ok
          ? {
              ok: true,
              ctx: {
                ...baseCtx,
                provider: explicitPin.resolution.provider,
                model: explicitPin.resolution.model,
              },
            }
          : { ok: false, ctx: baseCtx, error: explicitPin.error };
      }
      if (explicitModel !== null) {
        return explicitModel.ok
          ? { ok: true, ctx: explicitModel.ctx }
          : { ok: false, ctx: baseCtx, error: explicitModel.error };
      }
      return resolveWorkflowAgentModelContextDetailed(
        baseCtx,
        {
          ...(effectiveTier !== undefined ? { tier: effectiveTier } : {}),
          ...(effectiveDiversify !== undefined ? { diversify: effectiveDiversify } : {}),
        },
        { allocationCount },
        poolKey ? tierPinnedPools[poolKey] : undefined,
      );
    };
    const resolved = (
      await resolveWithModelFallbackDecision({
        resolve: resolveContext,
        inspect: (value) => (value.ok ? (value.fallbackDeviation ?? null) : null),
        // Workflow agents are autonomous: never raise the interactive ask and
        // never sleep out a cooldown (a quota window can be hours — the next
        // phase would silently stall). Take the substitute; degraded routing
        // is already surfaced via degradedReasons below.
        decisionHook: async () => ({
          decision: "use_fallback",
          timedOut: false,
        }),
        sleepUntil: (untilEpochMs) => sleepUntilWorkflowFallback(untilEpochMs, options.signal),
      })
    ).value;
    if (poolKey && resolved.ok && resolved.selectedPool && resolved.selectedPool.length > 0) {
      tierPinnedPools[poolKey] = resolved.selectedPool;
    }
    if (resolved.ok && resolved.degradedReasons) {
      const task = getRunningWorkflowByRunId(options.runId);
      if (task) {
        const current = task.degradedRouting || [];
        updateWorkflowTask(task.id, {
          degradedRouting: [...current, ...resolved.degradedReasons],
          logs: [...task.logs, ...resolved.degradedReasons.map((r) => `degraded routing: ${r}`)],
        });
      }
    }
    const selectedCtx = resolved.ok ? resolved.ctx : baseCtx;
    const agentCtx: RequestContext = {
      ...selectedCtx,
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    };
    const modelDisplay =
      findModel(agentCtx.model, agentCtx.provider)?.displayName ?? agentCtx.model;
    let agentOutputTokens = 0;

    const emit = (
      state: WorkflowAgentEvent["state"],
      extra?: Partial<WorkflowAgentEvent>,
    ): void => {
      const transcript = transcripts.get(agentId);
      const lastCall = transcript?.toolCalls.at(-1);
      const meterTotal = options.meter?.spent();
      options.onAgentEvent?.({
        index,
        label,
        agentId,
        prompt,
        ...(phaseTitle !== undefined ? { phaseTitle } : {}),
        provider: agentCtx.provider,
        model: modelDisplay,
        state,
        ...(transcript !== undefined ? { transcript } : {}),
        ...(lastCall !== undefined
          ? { lastToolName: lastCall.name, lastToolSummary: lastCall.summary }
          : {}),
        ...(agentOutputTokens > 0 ? { tokens: agentOutputTokens } : {}),
        ...(meterTotal !== undefined && meterTotal > 0 ? { totalTokens: meterTotal } : {}),
        ...(opts.agentType !== undefined ? { agentType: opts.agentType } : {}),
        ...(opts.isolation !== undefined ? { isolation: opts.isolation } : {}),
        ...(extra !== undefined ? extra : {}),
      });
    };

    if (options.journal && cacheKey !== undefined) {
      if (!cacheScope.chain.exhausted) {
        const cached = options.journal.results.get(cacheKey);
        if (cached !== undefined && cached.result !== null) {
          const cachedPreview = truncateWorkflowPreview(cached.result);
          emit("done", {
            cached: true,
            ...(cachedPreview !== undefined ? { resultPreview: cachedPreview } : {}),
          });
          return cloneWorkflowBoundaryValue(cached.result);
        }
        cacheScope.chain.exhausted = true;
      }
      const priorStarts = options.journal.started.get(cacheKey);
      if (
        priorStarts !== undefined &&
        priorStarts.length > 0 &&
        !options.journal.results.has(cacheKey)
      ) {
        options.log?.(
          `respawning agent "${label}" — previous attempt started but never completed (${priorStarts.length})`,
        );
      }
    }

    emit("start");
    await gate.acquire(agentCtx.provider);
    let emittedError = false;
    // A worktree-isolated agent owns ONE physical worktree for its whole logical
    // life: created before the retry loop, reused across every throttle/stall
    // attempt, and torn down once in the finally — after the journal result is
    // durable. Per-attempt cleanup would delete a clean tree between retries (so
    // a retry ran against drifted source) and drop the snapshot before the result
    // was recorded (so a crash-resume rebuilt from whatever the source held then).
    let managedWorktree: Worktree | null = null;
    let worktreeLease: WorktreeLease | null = null;
    try {
      if (!resolved.ok) throw buildVmSafeError(resolved.error);
      const profile = resolveWorkflowAgentProfile(opts.agentType, resolved.ctx);
      if (!profile.ok) throw buildVmSafeError(profile.error);
      if (opts.isolation === "worktree") {
        managedWorktree = await createWorktree(agentCtx.cwd, agentId);
        if (managedWorktree === null) {
          throw buildVmSafeError(
            "worktree isolation: failed to create or reuse the requested worktree",
          );
        }
        worktreeLease = await acquireWorktreeLease(managedWorktree.path);
      }
      // Record the dispatch before the fork so a crash mid-run is distinguishable
      // from a key that was never attempted.
      if (options.journal && cacheKey !== undefined) {
        await options.journal.append({
          type: "started",
          key: cacheKey,
          agentId,
        });
      }
      const runFork = forkRunnerOverride ?? options.runFork ?? defaultForkRunner;
      const meter = options.meter;
      const liveSink: ForkEventSink = (event) => {
        if (event.kind === "fork_usage") {
          if (event.isSnapshot) return;
          meter?.add(event.outputTokens);
          if (Number.isFinite(event.outputTokens) && event.outputTokens > 0) {
            agentOutputTokens += Math.floor(event.outputTokens);
          }
          emit("start");
          return;
        }
        if (event.kind === "fork_tool_dispatch_start") {
          transcripts.recordToolCall({
            agentId,
            name: event.toolName,
            toolInput: event.input,
          });
          emit("start");
          return;
        }
        if (event.kind === "fork_text_delta") {
          transcripts.appendText(agentId, event.text);
          return;
        }
        if (event.kind === "fork_stream_reset") {
          transcripts.discardText(agentId, event.discardedChars);
          return;
        }
        if (event.kind === "fork_complete") {
          transcripts.finalize(agentId, event.output);
        }
      };
      let forkOutcome: {
        result: SubagentResult;
        attempt: number;
        lastAttemptReason?: "throttled" | "stalled";
      } | null = null;
      let userRetries = 0;
      while (forkOutcome === null) {
        const agentController = new AbortController();
        const onParentAbort = (): void => agentController.abort(WORKFLOW_PARENT_ABORT_REASON);
        if (options.signal.aborted) agentController.abort(WORKFLOW_PARENT_ABORT_REASON);
        else
          options.signal.addEventListener("abort", onParentAbort, {
            once: true,
          });
        options.onAgentController?.(agentId, agentController);
        try {
          transcripts.begin(agentId, prompt);
          const forkRequest: WorkflowForkRequest = {
            // Sub-agents reason for real (effort inherited unless overridden), but
            // their reasoning summary is dropped where the provider can decouple it
            // so it is neither relayed to the parent nor accumulated as a re-sent
            // transcript. The parent reasons over the agent's output, not its
            // thinking.
            ctx: {
              ...agentCtx,
              abortSignal: agentController.signal,
              suppressThinkingSummary: true,
            },
            name: opts.agentType ?? "workflow-agent",
            body: profile.body,
            allowSet: profile.allowSet,
            extraDeclarations: profile.extraDeclarations,
            prompt,
            parentToolCallId: options.parentToolCallId,
            agentId,
            ...(isPlainObject(opts.schema) ? { outputSchema: opts.schema } : {}),
            ...(opts.isolation !== undefined ? { isolation: opts.isolation } : {}),
            // The owner-created worktree, reused verbatim across every retry.
            ...(managedWorktree !== null ? { worktree: managedWorktree } : {}),
            sink: liveSink,
          };
          const outcome = await runForkWithRetries(runFork, forkRequest, agentController.signal);
          const controlReason = agentController.signal.reason;
          // A manual workflow close aborts an in-flight fork with no structured output;
          // bail as cancellation before the schema validation below mistakes it for a
          // genuine missing-output failure.
          if (options.signal.aborted) {
            const preview = truncateWorkflowPreview("Workflow was aborted.");
            emit("error", {
              stopped: true,
              ...(preview !== undefined ? { resultPreview: preview } : {}),
            });
            emittedError = true;
            throw buildVmSafeError("Workflow was aborted.");
          }
          if (!options.signal.aborted && controlReason === WORKFLOW_AGENT_SKIP_REASON) {
            emit("error", { skipped: true });
            return null;
          }
          if (
            !options.signal.aborted &&
            controlReason === WORKFLOW_AGENT_RETRY_REASON &&
            userRetries < WORKFLOW_MAX_USER_RETRIES
          ) {
            userRetries += 1;
          } else {
            forkOutcome = outcome;
          }
        } finally {
          options.signal.removeEventListener("abort", onParentAbort);
          options.onAgentController?.(agentId, null);
        }
      }
      const { result, attempt, lastAttemptReason } = forkOutcome;
      const attemptExtra =
        attempt > 1
          ? lastAttemptReason !== undefined
            ? { attempt, lastAttemptReason }
            : { attempt }
          : {};
      if (result.isError) {
        if (options.signal.aborted) {
          const preview = truncateWorkflowPreview(result.output);
          emit("error", {
            stopped: true,
            ...attemptExtra,
            ...(preview !== undefined ? { resultPreview: preview } : {}),
          });
          emittedError = true;
          throw buildVmSafeError("Workflow was aborted.");
        }
        options.recordFailure?.(`${label}: ${result.output}`);
        const errorPreview = truncateWorkflowPreview(result.output);
        emit("error", {
          ...attemptExtra,
          ...(errorPreview !== undefined ? { resultPreview: errorPreview } : {}),
        });
        emittedError = true;
        // A schema-contract failure is a script bug and must throw so the
        // author sees it. A terminal API/provider failure resolves to null —
        // the documented agent() contract — so a sequential `await agent()`
        // in a later phase still dispatches instead of the whole script dying
        // on one dead agent.
        if (result.stopReason === "error_max_structured_output_retries") {
          throw buildVmSafeError(
            `StructuredOutputMismatchError: Schema validation failed. ${result.output}`,
          );
        }
        if (result.output?.includes("StructuredOutput")) {
          throw buildVmSafeError(`StructuredOutputMismatchError: ${result.output}`);
        }
        // Stall abandonment (all retry attempts made no progress) also throws:
        // it signals a wedged harness, not a provider verdict on this prompt.
        if (result.stalled === true) {
          throw buildVmSafeError(result.output);
        }
        return null;
      }
      let agentResult: unknown;
      if (opts.schema === undefined) {
        agentResult = result.output;
      } else if (result.structured !== undefined) {
        agentResult = cloneWorkflowBoundaryValue(result.structured);
      } else {
        options.recordFailure?.(`${label}: schema agent did not return structured output`);
        throw buildVmSafeError(
          `StructuredOutputMissingError: Schema was required but agent returned no structured output. Output: ${result.output}`,
        );
      }
      const donePreview =
        opts.schema === undefined
          ? truncateWorkflowPreview(result.output)
          : truncateWorkflowPreview(result.structured);
      if (options.journal && cacheKey !== undefined && agentResult !== null) {
        const resultEntry: WorkflowJournalResultEntry = {
          type: "result",
          key: cacheKey,
          agentId,
          result: agentResult,
        };
        await options.journal.append(resultEntry);
        options.journal.results.set(cacheKey, resultEntry);
      }
      emit("done", {
        ...attemptExtra,
        ...(donePreview !== undefined ? { resultPreview: donePreview } : {}),
      });
      return agentResult;
    } catch (error) {
      const message = errorMessage(error);
      options.recordFailure?.(`${label}: ${message}`);
      const catchPreview = truncateWorkflowPreview(message);
      if (!emittedError) {
        if (options.signal.aborted) {
          emit("error", {
            stopped: true,
            ...(catchPreview !== undefined ? { resultPreview: catchPreview } : {}),
          });
        } else {
          emit("error", catchPreview !== undefined ? { resultPreview: catchPreview } : undefined);
        }
        emittedError = true;
      }
      throw buildVmSafeError(error);
    } finally {
      // Single teardown after the journal result is durable: release the lease
      // first so the fail-closed guard doesn't block our own removal, then clean
      // up (preserved if the agent left changes in the worktree).
      if (worktreeLease) await worktreeLease.release();
      if (managedWorktree) await managedWorktree.cleanup();
      gate.release(agentCtx.provider);
    }
  };

  const runParallel = async (thunks: unknown): Promise<unknown[]> => {
    if (!Array.isArray(thunks)) {
      throw buildVmSafeError("parallel() requires an array of functions.");
    }
    if (thunks.length > WORKFLOW_MAX_PARALLEL_ITEMS) {
      throw buildVmSafeError(
        `parallel() accepts at most ${WORKFLOW_MAX_PARALLEL_ITEMS} items; got ${thunks.length}.`,
      );
    }
    // Validate every slot before dispatching any of them — a non-function
    // entry (e.g. a Promise passed instead of a `() => agent(...)` thunk) is
    // an authoring bug and must fail loudly, not silently resolve to null.
    thunks.forEach((thunk, index) => {
      if (typeof thunk !== "function") {
        throw buildVmSafeError(
          new TypeError(
            `parallel() expects an array of functions; slot ${index} is ${typeof thunk}.`,
          ),
        );
      }
    });
    return runCacheReplayBatch(
      "parallel",
      `items:${thunks.length}`,
      thunks as (() => unknown)[],
      async (thunk, index) => {
        try {
          return await thunk();
        } catch (error) {
          options.recordFailure?.(`parallel[${index}]: ${errorMessage(error)}`);
          return null;
        }
      },
    );
  };

  const runPipeline = async (items: unknown, ...stages: unknown[]): Promise<unknown[]> => {
    if (!Array.isArray(items)) {
      throw buildVmSafeError("pipeline() requires an array of items.");
    }
    if (items.length > WORKFLOW_MAX_PARALLEL_ITEMS) {
      throw buildVmSafeError(
        `pipeline() accepts at most ${WORKFLOW_MAX_PARALLEL_ITEMS} items; got ${items.length}.`,
      );
    }
    // Validate every stage before running any item — an invalid stage arg is
    // an authoring bug, caught at call time rather than skipped per item.
    stages.forEach((stage, index) => {
      if (typeof stage !== "function") {
        throw buildVmSafeError(
          new TypeError(
            `pipeline() expects a function for each stage; stage ${index} is ${typeof stage}.`,
          ),
        );
      }
    });
    return runCacheReplayBatch(
      "pipeline",
      `items:${items.length}:stages:${stages.length}`,
      items,
      async (item, index) => {
        let value: unknown = item;
        const itemScope = activeCacheScope();
        const typedStages = stages as ((prev: unknown, item: unknown, index: number) => unknown)[];
        for (const [stageIndex, stage] of typedStages.entries()) {
          // A null value short-circuits the rest of this item's chain — the
          // remaining stages are skipped and the item's result is null. Other
          // items are unaffected (each runs its own independent chain).
          if (value === null) break;
          const stageScope: CacheExecutionScope = {
            path: `${itemScope.path}/stage:${stageIndex}`,
            chain: itemScope.chain,
            operationIndex: 0,
          };
          try {
            value = await cacheScopeStorage.run(stageScope, () => stage(value, item, index));
          } catch (error) {
            options.recordFailure?.(`pipeline[${index}]: ${errorMessage(error)}`);
            return null;
          }
        }
        return value;
      },
    );
  };

  return {
    agent: runAgent,
    parallel: runParallel,
    pipeline: runPipeline,
    agentCount: () => agentSeq,
  };
}
