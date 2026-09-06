import type { TierName } from "@/engine/model/tier/names.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";

const CONTEXT_WINDOW_SUFFIX = /\[1m\]$/i;

export function baseModelId(model: string): string {
  return model.replace(CONTEXT_WINDOW_SUFFIX, "");
}

export type TierModel = {
  provider: ProviderId;
  name: string;
  pos: number;
};

export const LEAN_MODELS: readonly TierModel[] = [
  { provider: "anthropic", name: "claude-opus-5", pos: 1 },
];

export function isLeanModel(provider: ProviderId, model: string): boolean {
  return LEAN_MODELS.some((m) => m.provider === provider && m.name === baseModelId(model));
}

export const EMPEROR_MODELS: readonly TierModel[] = [
  { provider: "anthropic", name: "claude-opus-5", pos: 1 },
  { provider: "codex", name: "gpt-6-astra", pos: 2 },
];

export const SHOGUN_MODELS: readonly TierModel[] = [
  { provider: "xai", name: "grok-4.6", pos: 1 },
  { provider: "kimi", name: "k3", pos: 2 },
  { provider: "codex", name: "gpt-5.6-terra", pos: 3 },
  { provider: "anthropic", name: "claude-sonnet-5", pos: 4 },
  { provider: "glm", name: "glm-5.2", pos: 5 },
];

export const DAIMYO_MODELS: readonly TierModel[] = [
  { provider: "codex", name: "gpt-5.6-luna", pos: 1 },
  { provider: "antigravity", name: "gemini-3.8-flash", pos: 2 },
  { provider: "antigravity", name: "gemini-3.1-pro-high", pos: 3 },
  { provider: "xai", name: "grok-composer-2.5-fast", pos: 4 },
  { provider: "deepseek", name: "deepseek-v4-pro", pos: 5 },
  { provider: "kimi", name: "kimi-for-coding", pos: 6 },
];

export const SAMURAI_MODELS: readonly TierModel[] = [
  { provider: "antigravity", name: "gemini-3.8-flash-low", pos: 1 },
  { provider: "antigravity", name: "gemini-3.8-flash-medium", pos: 2 },
  { provider: "glm", name: "glm-5-turbo", pos: 3 },
  { provider: "anthropic", name: "claude-haiku-4-5", pos: 4 },
  { provider: "deepseek", name: "deepseek-v4-flash", pos: 5 },
  { provider: "minimax", name: "minimax-m3", pos: 6 },
  { provider: "kimi", name: "kimi-for-coding-highspeed", pos: 7 },
];

const TIER_SEEDS: Record<TierName, readonly TierModel[]> = {
  emperor: EMPEROR_MODELS,
  shogun: SHOGUN_MODELS,
  daimyo: DAIMYO_MODELS,
  samurai: SAMURAI_MODELS,
};

// The built-in roster for a tier, rank-sorted — the layer under any
// orchestration.json overlay.
export function seedTierRoster(tier: TierName): readonly TierModel[] {
  const list = TIER_SEEDS[tier];
  if (!list) return [];
  return [...list].sort((a, b) => a.pos - b.pos);
}

export function auxiliaryModelFor(provider: ProviderId): string {
  const samurai = SAMURAI_MODELS.find((m) => m.provider === provider);
  if (samurai) return samurai.name;
  const daimyo = DAIMYO_MODELS.find((m) => m.provider === provider);
  if (daimyo) return daimyo.name;
  return "inherit";
}
