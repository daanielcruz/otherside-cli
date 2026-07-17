import type { TierName } from "@/engine/model/tier/names.ts";

// When an agent names an agentType but omits an explicit tier, the runtime infers
// a default tier from the agentType's intent. Matched by substring (lowercased,
// first match wins) so both builtin types (explore, plan) and custom variants
// (code-explorer, ui-planner, security-reviewer) route sensibly. Inference never
// selects samurai: its models are the weakest and only run when a caller names
// the tier explicitly for occasional mechanical work. Recon/search/exploration
// route to fast capable execution (daimyo); planning and architecture are deep
// reasoning (emperor); review and verification need judgment (shogun). Anything
// unrecognized falls back to the fast-execution tier.
const AGENT_TYPE_TIER_PATTERNS: readonly (readonly [string, TierName])[] = [
  ["recon", "daimyo"],
  ["scout", "daimyo"],
  ["explor", "daimyo"],
  ["search", "daimyo"],
  ["architect", "emperor"],
  ["plan", "emperor"],
  ["review", "shogun"],
  ["verif", "shogun"],
  ["audit", "shogun"],
];

export const FALLBACK_AGENT_TIER: TierName = "daimyo";

export function defaultTierForAgentType(agentType: string | undefined): TierName {
  if (!agentType) return FALLBACK_AGENT_TIER;
  const needle = agentType.toLowerCase();
  for (const [pattern, tier] of AGENT_TYPE_TIER_PATTERNS) {
    if (needle.includes(pattern)) return tier;
  }
  return FALLBACK_AGENT_TIER;
}
