import type { TierName } from "@/engine/model/tier/names.ts";

// When an agent names an agentType but omits an explicit tier, the runtime infers
// a default tier from the agentType's intent. Matched by substring (lowercased,
// first match wins) so both builtin types (explore, plan) and custom variants
// (code-explorer, ui-planner, security-reviewer) route sensibly. Broad exploration
// defaults to the capable workhorse tier (warrior) — sweeps need reliable reading,
// not the weakest model; pure recon/search stay cheap/fast (scout); planning and
// architecture are deep reasoning (general); review and verification are capable
// iteration (warrior). Anything unrecognized falls back to the workhorse tier.
const AGENT_TYPE_TIER_PATTERNS: readonly (readonly [string, TierName])[] = [
  ["recon", "scout"],
  ["scout", "scout"],
  ["explor", "warrior"],
  ["search", "scout"],
  ["architect", "general"],
  ["plan", "general"],
  ["review", "warrior"],
  ["verif", "warrior"],
  ["audit", "warrior"],
];

export const FALLBACK_AGENT_TIER: TierName = "warrior";

export function defaultTierForAgentType(agentType: string | undefined): TierName {
  if (!agentType) return FALLBACK_AGENT_TIER;
  const needle = agentType.toLowerCase();
  for (const [pattern, tier] of AGENT_TYPE_TIER_PATTERNS) {
    if (needle.includes(pattern)) return tier;
  }
  return FALLBACK_AGENT_TIER;
}
