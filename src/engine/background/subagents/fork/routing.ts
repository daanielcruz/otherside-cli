import type { SubagentDef } from "@/engine/agents/registry.ts";
import { getProviderConfig } from "@/engine/contract/registry.ts";
import {
  availableModelsForProvider,
  defaultEffortForModel,
  effortLevelsForModel,
  findModel,
} from "@/engine/model/catalog.ts";
import {
  type ModelFallbackDeviation,
  rankOneCooldownDeviation,
  resolveWithModelFallbackDecision,
  routingNoticeForDeviation,
} from "@/engine/model/facts/model-fallback-decision.ts";
import { exhaustedProviderLaunchError, resolveModelPin } from "@/engine/model/facts/model-pin.ts";
import { isTierName, type TierName } from "@/engine/model/tier/names.ts";
import {
  isProviderUsableNow,
  isQuotaDisplacedCandidate,
  quotaDisplacedBeforeTopNSelection,
  resolveTierRankDetailed,
  resolveTierTopNWithCascadeDetailed,
  type TierCandidateDetail,
  tierModelCandidateNow,
  tierRosterSize,
  usableActiveProviderForTierResolution,
} from "@/engine/model/tier/resolver.ts";
import * as providers from "@/engine/providers/registry.ts";
import type { OrchestrationMode } from "@/kernel/config/orchestration-mode.ts";
import { isProviderId, type ProviderId } from "@/kernel/config/provider-ids.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { clampNestedPinnedModel, clampNestedTier, type TierClamp } from "./tier-ceiling.ts";
import type { SubagentInvocation, SubagentResult } from "./types.ts";

export type ToolRoutingResult =
  | {
      ok: true;
      ctx: RequestContext;
      routingNotice?: string;
      tierClampNotice?: string;
      fallbackDeviation?: ModelFallbackDeviation;
    }
  // gated: the refusal came from the disabled quota-fallback toggle, not from
  // resolution itself — callers surface those to the step, and only those.
  | { ok: false; error: string; gated?: boolean };

function modeOf(ctx: RequestContext): OrchestrationMode {
  return ctx.orchestrationMode ?? "disabled";
}

function withTierClampNotice(result: ToolRoutingResult, clamp: TierClamp): ToolRoutingResult {
  if (!result.ok) return result;
  return {
    ...result,
    routingNotice:
      result.routingNotice === undefined ? clamp.notice : `${clamp.notice} ${result.routingNotice}`,
    tierClampNotice: clamp.notice,
  };
}

function clampRequestedModel(
  ctx: RequestContext,
  provider: ProviderId,
  model: string,
): TierClamp | undefined {
  if (modeOf(ctx) !== "feudalism") return undefined;
  return clampNestedPinnedModel(ctx, provider, findModel(model, provider)?.id ?? model);
}

export function quotaRerouteForInvocation(
  ctx: RequestContext,
  invocation: SubagentInvocation,
  result: SubagentResult,
): { tier: TierName; provider: ProviderId } | undefined {
  if (modeOf(ctx) !== "feudalism") return undefined;
  if (result.quotaExhausted === undefined) return undefined;
  if (invocation.tierRankOverride !== undefined) return undefined;
  if (!invocation.tierOverride || !isTierName(invocation.tierOverride)) return undefined;
  const clamp = clampNestedTier(ctx, invocation.tierOverride);
  return {
    tier: clamp?.tier ?? invocation.tierOverride,
    provider: result.quotaExhausted.provider as ProviderId,
  };
}

export function resolveToolTierQuotaReroute(
  ctx: RequestContext,
  tier: TierName,
  exhaustedProvider: ProviderId,
): ToolRoutingResult {
  if (modeOf(ctx) !== "feudalism") {
    return {
      ok: false,
      error: "InputValidationError: quota fallback is available only in feudalism mode.",
    };
  }
  if (ctx.quotaFallbackEnabled === false) {
    return {
      ok: false,
      gated: true,
      error: `Quota fallback is disabled: ${exhaustedProvider} exhausted its quota mid-run and the step fails instead of rerouting. Enable "Quota fallback" in /config or retry after the quota resets.`,
    };
  }
  const activeProvider = usableActiveProviderForTierResolution(ctx.provider);
  const resolved = resolveTierTopNWithCascadeDetailed(tier, 1, exhaustedProvider, activeProvider);
  if (resolved.resolutions.length === 0) {
    return {
      ok: false,
      error: `No usable provider found for tier after ${exhaustedProvider} exhausted quota. Diagnostics: ${resolved.error ?? "no diagnostics available"}`,
    };
  }
  return {
    ok: true,
    ctx: {
      ...ctx,
      provider: resolved.resolutions[0]!.provider,
      model: resolved.resolutions[0]!.model,
    },
  };
}

function quotaFallbackDisabledError(tier: string, skipped: TierCandidateDetail): string {
  return `Quota fallback is disabled: tier "${tier}" would reroute past ${skipped.provider}/${skipped.model}, which is quota-blocked (${skipped.blockedReasons.join("; ")}). The step fails instead of rerouting. Enable "Quota fallback" in /config or retry after the quota resets.`;
}

export function resolveToolTierOverride(
  ctx: RequestContext,
  tierRaw: string,
  rankRaw?: number,
): ToolRoutingResult {
  const mode = modeOf(ctx);
  if (mode !== "feudalism") {
    const remedy =
      mode === "default"
        ? "use concrete `provider` + `model` pins or omit overrides"
        : "use `model` with an active-provider model id";
    return {
      ok: false,
      error: `InputValidationError: \`tier\` selection requires feudalism mode. Enable feudalism in /config, or ${remedy}.`,
    };
  }
  if (!isTierName(tierRaw)) {
    return {
      ok: false,
      error: "InputValidationError: tier must be one of: emperor, shogun, daimyo, samurai.",
    };
  }
  const activeProvider = usableActiveProviderForTierResolution(ctx.provider);
  if (rankRaw !== undefined) {
    const maxRank = tierRosterSize(tierRaw);
    if (!Number.isInteger(rankRaw) || rankRaw < 1 || rankRaw > maxRank) {
      return {
        ok: false,
        error: `InputValidationError: tier_rank / tierRank must be an integer between 1 and ${maxRank} for tier "${tierRaw}".`,
      };
    }
    const ranked = resolveTierRankDetailed(tierRaw, rankRaw, activeProvider);
    if (!ranked.resolution) {
      const slot = ranked.candidate
        ? `${ranked.candidate.provider}/${ranked.candidate.model}`
        : "the requested slot";
      const diagnostics = ranked.error ?? ranked.candidate?.summary ?? "no diagnostics available";
      return {
        ok: false,
        error: `InputValidationError: tier "${tierRaw}" rank ${rankRaw} (${slot}) is unavailable. Ranks are strict and map to a fixed roster slot — they do not fall back to another provider. Request a different rank, or authenticate / clear quota for ${ranked.candidate?.provider ?? "the ranked provider"}. Diagnostics: ${diagnostics}`,
      };
    }
    return {
      ok: true,
      ctx: {
        ...ctx,
        provider: ranked.resolution.provider,
        model: ranked.resolution.model,
      },
    };
  }
  // A bare tier keeps the caller's own model only when that model is currently
  // usable. Explicit rank remains a deliberate fixed slot and is honoured as-is.
  const callerCandidate = tierModelCandidateNow(tierRaw, ctx.provider, ctx.model, activeProvider);
  if (callerCandidate?.usable) {
    return { ok: true, ctx };
  }
  // The caller's own tier model being quota-blocked (e.g. a spent model-scoped
  // window) is itself a quota reroute: the cascade would silently move the step
  // to another slot, so a disabled fallback must fail here, not pass through.
  if (
    ctx.quotaFallbackEnabled === false &&
    callerCandidate !== null &&
    isQuotaDisplacedCandidate(callerCandidate)
  ) {
    return {
      ok: false,
      gated: true,
      error: quotaFallbackDisabledError(tierRaw, callerCandidate),
    };
  }
  const resolved = resolveTierTopNWithCascadeDetailed(tierRaw, 1, undefined, activeProvider);
  if (resolved.resolutions.length === 0) {
    if (isProviderUsableNow(ctx.provider, ctx.provider, ctx.model)) {
      return {
        ok: true,
        ctx,
        routingNotice: `No usable provider found in tier cascade "${tierRaw}"; using the active route ${ctx.provider}/${ctx.model}.`,
      };
    }
    return {
      ok: false,
      error: `No usable provider found for tier. All providers are unauthenticated, rate-limited, or quota-exhausted. Diagnostics: ${resolved.error ?? "no diagnostics available"}`,
    };
  }
  if (ctx.quotaFallbackEnabled === false) {
    const skipped = quotaDisplacedBeforeTopNSelection(resolved);
    if (skipped !== null) {
      return {
        ok: false,
        gated: true,
        error: quotaFallbackDisabledError(tierRaw, skipped),
      };
    }
  }
  const fallbackDeviation =
    rankOneCooldownDeviation(
      tierRaw,
      resolved.tiers.flatMap((entry) => entry.candidates),
      resolved.selected[0],
    ) ?? undefined;

  let routingNotice: string | undefined;
  if (resolved.selectedTier !== tierRaw) {
    routingNotice = `Tier "${tierRaw}" unavailable; using lower tier "${resolved.selectedTier}".`;
  } else if (fallbackDeviation !== undefined) {
    routingNotice = routingNoticeForDeviation(fallbackDeviation);
  }

  return {
    ok: true,
    ctx: {
      ...ctx,
      provider: resolved.resolutions[0]!.provider,
      model: resolved.resolutions[0]!.model,
    },
    ...(routingNotice !== undefined ? { routingNotice } : {}),
    ...(fallbackDeviation !== undefined ? { fallbackDeviation } : {}),
  };
}

export async function resolveSubagentRoutingForDispatch(
  ctx: RequestContext,
  def: SubagentDef,
  invocation: SubagentInvocation,
): Promise<ToolRoutingResult> {
  const result = await resolveWithModelFallbackDecision({
    resolve: () => resolveSubagentRouting(ctx, def, invocation),
    inspect: (value) => (value.ok ? (value.fallbackDeviation ?? null) : null),
    sleepUntil: (untilEpochMs) => sleepUntilSubagentFallback(untilEpochMs, ctx.abortSignal),
  });
  return result.value;
}

function sleepUntilSubagentFallback(
  untilEpochMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const delayMs = Math.max(0, untilEpochMs - Date.now());
  if (delayMs === 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error("Subagent dispatch was aborted."));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("Subagent dispatch was aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function resolveSubagentRouting(
  ctx: RequestContext,
  def: SubagentDef,
  invocation: SubagentInvocation,
): ToolRoutingResult {
  if (invocation.providerOverride !== undefined) {
    if (modeOf(ctx) === "disabled") {
      return {
        ok: false,
        error:
          "InputValidationError: `provider` is unavailable when orchestration is disabled. Use `model` with an active-provider model id.",
      };
    }
    if (modeOf(ctx) === "feudalism") {
      return {
        ok: false,
        error:
          "InputValidationError: concrete `provider`/`model` pins are unavailable in feudalism mode. Use `tier` routing instead.",
      };
    }
    if (invocation.modelOverride === undefined) {
      return {
        ok: false,
        error: "InputValidationError: `provider` requires `model` to name the pinned model.",
      };
    }
    const clamp = isProviderId(invocation.providerOverride)
      ? clampRequestedModel(ctx, invocation.providerOverride, invocation.modelOverride)
      : undefined;
    if (clamp !== undefined) {
      return withTierClampNotice(resolveToolTierOverride(ctx, clamp.tier), clamp);
    }
    const pin = resolveModelPin(
      invocation.providerOverride,
      invocation.modelOverride,
      ctx.provider,
      modeOf(ctx),
    );
    if (!pin.ok) return pin;
    const next: RequestContext = {
      ...ctx,
      provider: pin.resolution.provider,
      model: pin.resolution.model,
    };
    if (
      next.effort !== null &&
      !effortLevelsForModel(next.model, next.provider).includes(next.effort)
    ) {
      next.effort = defaultEffortForModel(next.model, next.provider);
    }
    return { ok: true, ctx: next };
  }
  if (invocation.modelOverride !== undefined) {
    if (modeOf(ctx) === "feudalism") {
      return {
        ok: false,
        error:
          "InputValidationError: concrete `model` pins are unavailable in feudalism mode. Use `tier` routing instead.",
      };
    }
    const clamp = clampRequestedModel(ctx, ctx.provider, invocation.modelOverride);
    if (clamp !== undefined) {
      return withTierClampNotice(resolveToolTierOverride(ctx, clamp.tier), clamp);
    }
    return resolveToolModelOverride(ctx, invocation.modelOverride);
  }
  if (invocation.tierOverride !== undefined) {
    const clamp = isTierName(invocation.tierOverride)
      ? clampNestedTier(ctx, invocation.tierOverride)
      : undefined;
    if (clamp !== undefined) {
      return withTierClampNotice(
        resolveToolTierOverride(ctx, clamp.tier, invocation.tierRankOverride),
        clamp,
      );
    }
    return resolveToolTierOverride(ctx, invocation.tierOverride, invocation.tierRankOverride);
  }
  return resolveAgentDefinitionModelOverride(ctx, def);
}

function resolveAgentDefinitionModelOverride(
  ctx: RequestContext,
  def: SubagentDef,
): ToolRoutingResult {
  const key = getProviderConfig(ctx.provider)?.provider.shortKey ?? ctx.provider;
  const override = def.model[key];
  if (!override) {
    const error = exhaustedProviderLaunchError(ctx.provider, ctx.provider, ctx.model, modeOf(ctx));
    return error === null ? { ok: true, ctx } : { ok: false, error };
  }
  const clamp = clampRequestedModel(ctx, ctx.provider, override.model);
  if (clamp !== undefined) {
    return withTierClampNotice(resolveToolTierOverride(ctx, clamp.tier), clamp);
  }
  const resolved = resolveToolModelOverride(ctx, override.model);
  if (!resolved.ok) return resolved;
  if (!override.effort) return resolved;
  return {
    ok: true,
    ctx: {
      ...resolved.ctx,
      effort: override.effort as RequestContext["effort"],
    },
  };
}

export function resolveToolModelOverride(
  ctx: RequestContext,
  override: string | undefined,
): { ok: true; ctx: RequestContext } | { ok: false; error: string } {
  if (!override || override.length === 0) return { ok: true, ctx };
  const provider = providers.get(ctx.provider);
  const entry = findModel(override, ctx.provider);
  const inCatalog = entry !== undefined && entry.provider === ctx.provider;
  const custom = provider.allowsCustomModel();
  const model = inCatalog && entry !== undefined ? entry.id : override;
  const available = provider.modelAvailable(model);
  if ((!inCatalog && !custom) || !available) {
    return {
      ok: false,
      error: invalidModelOverrideError(override, ctx.provider),
    };
  }
  const quotaError = exhaustedProviderLaunchError(ctx.provider, ctx.provider, model, modeOf(ctx));
  if (quotaError !== null) return { ok: false, error: quotaError };
  const next: RequestContext = { ...ctx, model };
  if (next.effort !== null && !effortLevelsForModel(model, ctx.provider).includes(next.effort)) {
    next.effort = defaultEffortForModel(model, ctx.provider);
  }
  return { ok: true, ctx: next };
}

function invalidModelOverrideError(
  override: string,
  providerId: RequestContext["provider"],
): string {
  const available = availableModelsForProvider(providerId).map((m) => m.id);
  const roster =
    available.length > 0
      ? ` Available model ids for "${providerId}": ${available.join(", ")}.`
      : providers.get(providerId).allowsCustomModel()
        ? " No static model roster is available for this provider; use a model id exposed by the active provider."
        : ` No model overrides are currently available for "${providerId}".`;
  return `InputValidationError: model "${override}" is not available on active provider "${providerId}".${roster} Cross-provider model ids and unknown aliases are rejected. Use a model exposed by the active provider, or omit \`model\` to inherit the parent model.`;
}
