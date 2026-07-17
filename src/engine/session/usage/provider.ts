import { findModel } from "@/engine/model/catalog.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { ProviderUsageTotals } from "@/kernel/storage/provider-usage.ts";
import type { UsageWarning } from "./limits.ts";

export type { ProviderUsageTotals } from "@/kernel/storage/provider-usage.ts";

export type UsageByProvider = Partial<Record<ProviderId, ProviderUsageTotals>>;

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export function emptyProviderUsage(): ProviderUsageTotals {
  return {
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

export function emptyTokenTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

export function totalProviderTokens(usage: ProviderUsageTotals): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.thoughtTokens +
    (usage.cacheCreationInputTokens ?? 0) +
    (usage.cacheReadInputTokens ?? 0)
  );
}

export function totalTokenTotals(usage: TokenTotals): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.thoughtTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens
  );
}

export function addTokenTotals(current: TokenTotals, delta: TokenTotals): TokenTotals {
  return {
    inputTokens: current.inputTokens + delta.inputTokens,
    outputTokens: current.outputTokens + delta.outputTokens,
    thoughtTokens: current.thoughtTokens + delta.thoughtTokens,
    cacheCreationInputTokens: current.cacheCreationInputTokens + delta.cacheCreationInputTokens,
    cacheReadInputTokens: current.cacheReadInputTokens + delta.cacheReadInputTokens,
  };
}

export function positiveTokenDelta(previous: TokenTotals, next: TokenTotals): TokenTotals {
  return {
    inputTokens: Math.max(0, next.inputTokens - previous.inputTokens),
    outputTokens: Math.max(0, next.outputTokens - previous.outputTokens),
    thoughtTokens: Math.max(0, next.thoughtTokens - previous.thoughtTokens),
    cacheCreationInputTokens: Math.max(
      0,
      next.cacheCreationInputTokens - previous.cacheCreationInputTokens,
    ),
    cacheReadInputTokens: Math.max(0, next.cacheReadInputTokens - previous.cacheReadInputTokens),
  };
}

export function hasTokenUsage(usage: TokenTotals): boolean {
  return totalTokenTotals(usage) > 0;
}

export function addProviderUsage(args: {
  current: ProviderUsageTotals;
  model: string;
  usage: TokenTotals;
  requestCount?: number;
}): ProviderUsageTotals {
  const { current, model, usage, requestCount = 0 } = args;
  return {
    requestCount: current.requestCount + requestCount,
    inputTokens: current.inputTokens + usage.inputTokens,
    outputTokens: current.outputTokens + usage.outputTokens,
    thoughtTokens: current.thoughtTokens + usage.thoughtTokens,
    cacheCreationInputTokens:
      (current.cacheCreationInputTokens ?? 0) + usage.cacheCreationInputTokens,
    cacheReadInputTokens: (current.cacheReadInputTokens ?? 0) + usage.cacheReadInputTokens,
    lastModel: model,
  };
}

export function tokenTotalsFromUsageByProvider(usageByProvider: UsageByProvider): TokenTotals {
  const total = emptyTokenTotals();
  for (const usage of Object.values(usageByProvider)) {
    if (!usage) continue;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.thoughtTokens += usage.thoughtTokens;
    total.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
    total.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
  }
  return total;
}

export function providerContextUtilization(
  modelId: string,
  currentContextTokens: number,
  provider?: ProviderId,
): number | null {
  const model = findModel(modelId, provider);
  if (!model || model.contextWindow <= 0) return null;
  return (currentContextTokens / model.contextWindow) * 100;
}

export function providerContextWarning(
  provider: ProviderId,
  modelId: string,
  currentContextTokens: number,
): UsageWarning | null {
  if (provider === "openai") return null;
  const utilization = providerContextUtilization(modelId, currentContextTokens, provider);
  if (utilization === null || utilization < 90) return null;
  const used = Math.min(100, Math.floor(utilization));
  return {
    message: `You've used ${used}% of your context window`,
    severity: utilization >= 100 ? "error" : "warning",
  };
}
