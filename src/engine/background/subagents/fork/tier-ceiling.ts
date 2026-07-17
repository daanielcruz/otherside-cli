import type { TierName } from "@/engine/model/tier/names.ts";
import { tierContainsModel } from "@/engine/model/tier/resolver.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { agentSpawnDepth } from "./spawn-depth.ts";

const TIER_RANK: Record<TierName, number> = {
  samurai: 0,
  daimyo: 1,
  shogun: 2,
  emperor: 3,
};

const TIER_LOOKUP_ORDER: readonly TierName[] = ["emperor", "shogun", "daimyo", "samurai"];

export interface TierClamp {
  tier: TierName;
  notice: string;
}

export function tierForModel(provider: ProviderId, model: string): TierName | undefined {
  return TIER_LOOKUP_ORDER.find((tier) => tierContainsModel(tier, provider, model));
}

export function nestedTierCeiling(ctx: RequestContext): TierName | undefined {
  if (ctx.chainOfCommandEnabled === false) return undefined;
  if (agentSpawnDepth(ctx) === 0) return undefined;
  return tierForModel(ctx.provider, ctx.model);
}

export function clampNestedTier(
  ctx: RequestContext,
  requestedTier: TierName,
): TierClamp | undefined {
  const ceiling = nestedTierCeiling(ctx);
  if (ceiling === undefined || TIER_RANK[requestedTier] <= TIER_RANK[ceiling]) return undefined;
  return {
    tier: ceiling,
    notice: `tier clamped to ${ceiling}: nested agents cannot launch above their own tier.`,
  };
}

export function clampNestedPinnedModel(
  ctx: RequestContext,
  provider: ProviderId,
  model: string,
): TierClamp | undefined {
  const requestedTier = tierForModel(provider, model);
  return requestedTier === undefined ? undefined : clampNestedTier(ctx, requestedTier);
}
