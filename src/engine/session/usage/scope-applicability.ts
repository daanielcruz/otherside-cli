import { isFableModel } from "@/engine/model/facts/model-family.ts";
import { baseModelId } from "@/engine/model/tier/tiers.ts";
import type { ProviderAllocation, ScopeApplicability } from "@/kernel/channels/usage-limits.ts";
import type { ProviderId, ProviderModelRoute } from "@/kernel/std/types/provider-ids.ts";

// Scope-vs-route applicability SoT: routing eligibility and the passive quota
// warning must agree on which concrete (provider, model) route a family/model
// scope gates. Model identity is never transported without its provider.

/**
 * Model family used to match "family"-applicability scopes. Provider ownership
 * is part of the route and therefore adjudicates identical-looking model ids:
 * antigravity splits claude/gpt/oss vs gemini, anthropic recognizes Fable, and
 * codex recognizes Spark.
 */
function familyForRoute(route: ProviderModelRoute): string | null {
  const normalized = normalizeRouteModelId(route);
  if (normalized.length === 0) return null;
  switch (route.provider) {
    case "antigravity":
      return /^claude|^gpt|oss/i.test(normalized) ? "claude-gpt" : "gemini";
    case "anthropic":
      return isFableModel(normalized) ? "fable" : null;
    case "codex":
      return normalized.toLowerCase().includes("spark") ? "spark" : null;
    default:
      return null;
  }
}

function normalizeRouteModelId(route: ProviderModelRoute): string {
  return baseModelId(route.model).trim();
}

/**
 * Whether one scope gates this concrete route: "global" always applies,
 * "family" applies when the route normalizes into that provider's family,
 * "model" applies on an exact normalized-id match within that provider, and
 * "informational" scopes never gate anything.
 */
export function scopeAppliesToRoute(
  applicability: ScopeApplicability,
  route: ProviderModelRoute,
): boolean {
  switch (applicability.type) {
    case "global":
      return true;
    case "informational":
      return false;
    case "family":
      return familyForRoute(route) === applicability.id;
    case "model":
      return normalizeRouteModelId(route) === applicability.id;
    default:
      return false;
  }
}

/**
 * Whether one scope's WARNING concerns any concrete route currently allocated
 * on `provider`. Provider-wide scopes ("global", plus "informational" — which
 * carries no model identity at all) concern every allocation; a family/model
 * scope concerns only an allocation carrying a matching (provider, model)
 * route. Provider-only allocations never match family/model scopes.
 */
export function scopeWarnsForAllocations(
  provider: ProviderId,
  applicability: ScopeApplicability,
  allocations: readonly ProviderAllocation[],
): boolean {
  if (applicability.type === "global" || applicability.type === "informational") return true;
  for (const allocation of allocations) {
    if (allocation.provider !== provider || allocation.model === undefined) continue;
    if (scopeAppliesToRoute(applicability, allocation)) return true;
  }
  return false;
}
