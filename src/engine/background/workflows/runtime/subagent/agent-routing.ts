import { clampNestedTier } from "@/engine/background/subagents/fork/tier-ceiling.ts";
import {
  type ModelFallbackDeviation,
  rankOneCooldownDeviation,
  routingNoticeForDeviation,
} from "@/engine/model/facts/model-fallback-decision.ts";
import { exhaustedProviderLaunchError } from "@/engine/model/facts/model-pin.ts";
import { defaultTierForAgentType } from "@/engine/model/tier/agent-defaults.ts";
import { isTierName } from "@/engine/model/tier/names.ts";
import {
  isQuotaDisplacedCandidate,
  quotaDisplacedBeforeTopNSelection,
} from "@/engine/model/tier/quota-displacement.ts";
import {
  resolveTierTopNWithCascadeDetailed,
  type TierCandidateDetail,
  type TierResolution,
  tierModelCandidateNow,
} from "@/engine/model/tier/resolver.ts";
import {
  isProviderUsableNow,
  usableActiveProviderForTierResolution,
} from "@/engine/model/tier/usability.ts";
import type { OrchestrationMode } from "@/kernel/std/types/orchestration-mode.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { readAgentOptions } from "./agent-options.ts";
import type { WorkflowAgentModelContextDetail } from "./bridge-contract.ts";

const DIVERSIFY_PROVIDER_SPREAD = 3;
const BEST_OF_TIER_SPREAD = 1;

export function orchestrationModeOf(ctx: RequestContext): OrchestrationMode {
  return ctx.orchestrationMode ?? "disabled";
}

export function workflowOrchestrationOptionError(
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
