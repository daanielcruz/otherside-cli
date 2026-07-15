import { roughTokenCountEstimation } from "@/engine/session/compact/token-count.ts";
import { contextWindowWarning } from "@/engine/session/usage/context.ts";
import type { UsageWarning } from "@/engine/session/usage/limits.ts";
import type { TokenTotals } from "@/engine/session/usage/provider.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";

interface ChipUsageContextSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface DeriveChipUsageArgs {
  mainLastContext: ChipUsageContextSnapshot;
  mainTokenTotals: TokenTotals;
  provider: ProviderId;
  model: string;
  contextWarningSuppressed: boolean;
  fallbackContextTokens: number;
  busy: boolean;
  liveOutputTokensValue: number;
  queuedText: string;
  autoCompactRemainingPct: (used: number) => number | undefined;
}

export interface ChipUsage {
  serverContextTotal: number;
  contextBanner: UsageWarning | null;
  queuedTokens: number;
  activeContextTotal: number;
  autoCompactWarningPct: number | undefined;
  fallbackInputTokens: number;
  mainOutputTokens: number;
}

export function deriveChipUsage(args: DeriveChipUsageArgs): ChipUsage {
  const {
    mainLastContext,
    mainTokenTotals,
    provider,
    model,
    contextWarningSuppressed,
    fallbackContextTokens,
    busy,
    liveOutputTokensValue,
    queuedText,
    autoCompactRemainingPct,
  } = args;
  const serverContextTotal =
    mainLastContext.inputTokens +
    mainLastContext.cacheCreationInputTokens +
    mainLastContext.cacheReadInputTokens;
  const contextBanner = contextWindowWarning({
    provider,
    model,
    totals: mainLastContext,
    suppressed: contextWarningSuppressed,
  });
  const queuedTokens = queuedText.length > 0 ? roughTokenCountEstimation(queuedText) : 0;
  const liveOutputTokens = busy
    ? Math.max(liveOutputTokensValue, mainLastContext.outputTokens)
    : mainLastContext.outputTokens;
  const fallbackOutputTokens = busy
    ? Math.max(liveOutputTokensValue, mainTokenTotals.outputTokens)
    : mainTokenTotals.outputTokens;
  const serverTokenUsage =
    serverContextTotal > 0
      ? serverContextTotal + liveOutputTokens
      : fallbackContextTokens + fallbackOutputTokens;
  const activeContextTotal = serverTokenUsage + queuedTokens;
  const liveAutoCompactPct = autoCompactRemainingPct(serverTokenUsage);
  const autoCompactWarningPct =
    liveAutoCompactPct !== undefined && liveAutoCompactPct <= 30 ? liveAutoCompactPct : undefined;
  const fallbackInputTokens =
    serverContextTotal > 0
      ? mainLastContext.inputTokens + queuedTokens
      : fallbackContextTokens + queuedTokens;
  const mainOutputTokens =
    serverContextTotal > 0 ? mainLastContext.outputTokens : mainTokenTotals.outputTokens;
  return {
    serverContextTotal,
    contextBanner,
    queuedTokens,
    activeContextTotal,
    autoCompactWarningPct,
    fallbackInputTokens,
    mainOutputTokens,
  };
}
