import type { ModelPricing } from "@/engine/contract/pricing.ts";

export interface CostEstimate {
  input: number;
  output: number;
  total: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number | undefined;
}

export function costFor(usage: TokenUsage, rates: ModelPricing): CostEstimate {
  const input = (usage.inputTokens / 1_000_000) * rates.inputPerM;
  const output = (usage.outputTokens / 1_000_000) * rates.outputPerM;
  const cached =
    usage.cacheReadInputTokens !== undefined && rates.cachedInputPerM !== undefined
      ? (usage.cacheReadInputTokens / 1_000_000) * rates.cachedInputPerM
      : 0;
  return {
    input,
    output,
    total: input + output + cached,
  };
}

export function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.001) return `< $0.001`;
  return `$${cost.toFixed(3)}`;
}
