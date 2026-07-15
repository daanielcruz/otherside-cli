import { availableModelsForProvider } from "@/engine/model/catalog.ts";
import { TIER_NAMES } from "@/engine/model/tier/names.ts";
import { isProviderUsableNow, resolveTierDetailed } from "@/engine/model/tier/resolver.ts";
import { baseModelId } from "@/engine/model/tier/tiers.ts";
import { PROVIDER_ID_VALUES, type ProviderId } from "@/kernel/config/provider-ids.ts";

export interface AvailableProviderModels {
  provider: ProviderId;
  models: { id: string; display: string; onDemand?: boolean }[];
}

/**
 * Models usable for multiprovider delegation, grouped by provider.
 * Providers are ordered by their strongest tier appearance (general →
 * warrior → scout); usable providers with no tier membership follow in
 * registry order. Within a provider the FULL model catalog is listed —
 * not just tier members — in catalog (strongest-first) order, deduped by
 * base id. Models without remaining quota (or credentials) are omitted.
 */
export function availableModelListing(activeProvider?: ProviderId): AvailableProviderModels[] {
  const providerOrder: ProviderId[] = [];
  for (const tier of TIER_NAMES) {
    const detail = resolveTierDetailed(tier, undefined, activeProvider);
    for (const candidate of detail.candidates) {
      if (!candidate.usable) continue;
      if (!providerOrder.includes(candidate.provider)) providerOrder.push(candidate.provider);
    }
  }
  for (const provider of PROVIDER_ID_VALUES) {
    if (!providerOrder.includes(provider) && isProviderUsableNow(provider, activeProvider)) {
      providerOrder.push(provider);
    }
  }

  const groups: AvailableProviderModels[] = [];
  for (const provider of providerOrder) {
    const seenBase = new Set<string>();
    const models: { id: string; display: string; onDemand?: boolean }[] = [];
    for (const entry of availableModelsForProvider(provider)) {
      const base = baseModelId(entry.id);
      if (seenBase.has(base)) continue;
      if (!isProviderUsableNow(provider, activeProvider, entry.id)) continue;
      seenBase.add(base);
      models.push({
        id: entry.id,
        display: entry.displayName,
        ...(entry.onDemand === true ? { onDemand: true } : {}),
      });
    }
    if (models.length > 0) groups.push({ provider, models });
  }
  return groups;
}
