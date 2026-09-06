import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";

interface HarnessBaseline {
  systemTokens: number;
  toolDefTokens: number;
}

const PROVIDER_BASELINE: Record<ProviderId, HarnessBaseline> = {
  anthropic: { systemTokens: 4_500, toolDefTokens: 8_500 },
  antigravity: { systemTokens: 4_500, toolDefTokens: 7_500 },
  codex: { systemTokens: 11_500, toolDefTokens: 4_500 },
  xai: { systemTokens: 4_500, toolDefTokens: 8_500 },
  kimi: { systemTokens: 4_500, toolDefTokens: 8_500 },
  minimax: { systemTokens: 4_500, toolDefTokens: 8_500 },
  glm: { systemTokens: 4_500, toolDefTokens: 8_500 },
  deepseek: { systemTokens: 4_500, toolDefTokens: 8_500 },
  openai: { systemTokens: 1_500, toolDefTokens: 3_500 },
};

const MODEL_OVERRIDES: Record<string, Partial<HarnessBaseline>> = {
  "claude-opus-4-8": { systemTokens: 4_500, toolDefTokens: 8_500 },
};

export function estimateHarnessTokens(provider: ProviderId, model: string): number {
  const base = PROVIDER_BASELINE[provider];
  if (!base) return 0;
  const override = MODEL_OVERRIDES[model] ?? {};
  const sys = override.systemTokens ?? base.systemTokens;
  const tools = override.toolDefTokens ?? base.toolDefTokens;
  return sys + tools;
}

export function harnessBaselineBreakdown(provider: ProviderId, model: string): HarnessBaseline {
  const base = PROVIDER_BASELINE[provider];
  if (!base) return { systemTokens: 0, toolDefTokens: 0 };
  const override = MODEL_OVERRIDES[model] ?? {};
  return {
    systemTokens: override.systemTokens ?? base.systemTokens,
    toolDefTokens: override.toolDefTokens ?? base.toolDefTokens,
  };
}
