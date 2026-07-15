import { findModel } from "@/engine/model/catalog.ts";
import { TIER_NAMES } from "@/engine/model/tier/names.ts";
import { resolvedTierRoster } from "@/engine/model/tier/resolver.ts";
import type { ResolvedTierEntry, ResolvedTierRoster } from "@/harness/core/tier-guidance.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";

export function resolveTierRosterData(activeProvider: ProviderId): ResolvedTierRoster {
  const resolved = resolvedTierRoster(activeProvider);
  const roster = {} as ResolvedTierRoster;
  for (const tier of TIER_NAMES) {
    roster[tier] = resolved[tier].map(
      (entry): ResolvedTierEntry => ({
        provider: entry.provider,
        display: findModel(entry.model, entry.provider)?.displayName ?? entry.model,
      }),
    );
  }
  return roster;
}
