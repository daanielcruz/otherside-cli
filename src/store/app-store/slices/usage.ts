import type { CodexUsage } from "@/engine/providers/codex/usage.ts";
import {
  emptyTokenTotals,
  type TokenTotals,
  type UsageByProvider,
} from "@/engine/session/usage/provider.ts";
import type { AppAction } from "@/store/app-store/types.ts";

export interface ContextUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface UsageSlice {
  readonly byProvider: UsageByProvider;
  readonly offlineByProvider: UsageByProvider;
  readonly codex: CodexUsage | null;
  readonly mainTotals: TokenTotals;
  readonly mainLastContext: ContextUsageSnapshot;
}

export const initialUsageSlice: UsageSlice = {
  byProvider: {},
  offlineByProvider: {},
  codex: null,
  mainTotals: emptyTokenTotals(),
  mainLastContext: {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  },
};

export function mergeContextUsageSnapshot(
  previous: ContextUsageSnapshot,
  event: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    cacheCreationInputTokens?: number | undefined;
    cacheReadInputTokens?: number | undefined;
  },
): ContextUsageSnapshot {
  return {
    inputTokens: event.inputTokens ?? previous.inputTokens,
    outputTokens: event.outputTokens ?? previous.outputTokens,
    cacheCreationInputTokens: event.cacheCreationInputTokens ?? previous.cacheCreationInputTokens,
    cacheReadInputTokens: event.cacheReadInputTokens ?? previous.cacheReadInputTokens,
  };
}

export function contextUsageTotal(
  usage: Pick<
    ContextUsageSnapshot,
    "inputTokens" | "cacheCreationInputTokens" | "cacheReadInputTokens"
  >,
): number {
  return usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
}

export function usageReducer(prev: UsageSlice, action: AppAction): UsageSlice {
  switch (action.type) {
    case "usage/setByProvider":
      return prev.byProvider === action.value ? prev : { ...prev, byProvider: action.value };
    case "usage/updateByProvider": {
      const next = action.updater(prev.byProvider);
      return next === prev.byProvider ? prev : { ...prev, byProvider: next };
    }
    case "usage/setOfflineByProvider":
      return prev.offlineByProvider === action.value
        ? prev
        : { ...prev, offlineByProvider: action.value };
    case "usage/updateOfflineByProvider": {
      const next = action.updater(prev.offlineByProvider);
      return next === prev.offlineByProvider ? prev : { ...prev, offlineByProvider: next };
    }
    case "usage/setCodex":
      return prev.codex === action.value ? prev : { ...prev, codex: action.value };
    case "usage/setMainTotals":
      return prev.mainTotals === action.value ? prev : { ...prev, mainTotals: action.value };
    case "usage/updateMainTotals": {
      const next = action.updater(prev.mainTotals);
      return next === prev.mainTotals ? prev : { ...prev, mainTotals: next };
    }
    case "usage/setMainLastContext":
      return prev.mainLastContext === action.value
        ? prev
        : { ...prev, mainLastContext: action.value };
    default:
      return prev;
  }
}
