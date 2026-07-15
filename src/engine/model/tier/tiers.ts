import type { ProviderId } from "@/kernel/config/provider-ids.ts";

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
  { provider: "anthropic", name: "claude-fable-5", pos: 1 },
  { provider: "anthropic", name: "claude-opus-4-8", pos: 2 },
];

export function isLeanModel(provider: ProviderId, model: string): boolean {
  return LEAN_MODELS.some((m) => m.provider === provider && m.name === baseModelId(model));
}

export const GENERAL_MODELS: readonly TierModel[] = [
  { provider: "codex", name: "gpt-5.6-sol", pos: 1 },
  { provider: "anthropic", name: "claude-fable-5", pos: 2 },
  { provider: "anthropic", name: "claude-opus-4-8", pos: 3 },
  { provider: "xai", name: "grok-4.5", pos: 4 },
  { provider: "glm", name: "glm-5.2", pos: 5 },
  { provider: "antigravity", name: "gemini-3.1-pro-high", pos: 6 },
];

export const WARRIOR_MODELS: readonly TierModel[] = [
  { provider: "antigravity", name: "gemini-3-flash", pos: 1 },
  { provider: "codex", name: "gpt-5.6-terra", pos: 2 },
  { provider: "anthropic", name: "claude-sonnet-5", pos: 5 },
  { provider: "xai", name: "grok-composer-2.5-fast", pos: 6 },
  { provider: "glm", name: "glm-5-turbo", pos: 7 },
  { provider: "deepseek", name: "deepseek-v4-flash", pos: 8 },
  { provider: "kimi-code", name: "kimi-for-coding", pos: 9 },
  { provider: "minimax", name: "minimax-m3", pos: 10 },
];

export const SCOUT_MODELS: readonly TierModel[] = [
  { provider: "antigravity", name: "gemini-3-flash-medium", pos: 1 }, // we choose gemini instead luna or grok composer because its more cheap for scouting.
  { provider: "xai", name: "grok-composer-2.5-fast", pos: 2 },
  { provider: "codex", name: "gpt-5.6-luna", pos: 3 },
  { provider: "anthropic", name: "claude-haiku-4-5", pos: 4 },
  { provider: "glm", name: "glm-5-turbo", pos: 5 },
];

export function auxiliaryModelFor(provider: ProviderId): string {
  const scout = SCOUT_MODELS.find((m) => m.provider === provider);
  if (scout) return scout.name;
  const warrior = WARRIOR_MODELS.find((m) => m.provider === provider);
  if (warrior) return warrior.name;
  return "inherit";
}
