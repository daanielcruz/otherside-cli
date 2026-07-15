import type { CodexUsage } from "@/engine/providers/codex/usage.ts";
import type { TokenTotals, UsageByProvider } from "@/engine/session/usage/provider.ts";
import type { ContextUsageSnapshot } from "@/engine/session/usage/snapshot.ts";
import { appStore, dispatch } from "@/store/index.ts";

export interface UsageSetters {
  setUsageByProvider: (
    next: UsageByProvider | ((prev: UsageByProvider) => UsageByProvider),
  ) => void;
  setOfflineUsageByProvider: (
    next: UsageByProvider | ((prev: UsageByProvider) => UsageByProvider),
  ) => void;
  setCodexUsage: (
    next: CodexUsage | null | ((prev: CodexUsage | null) => CodexUsage | null),
  ) => void;
  setMainTokenTotals: (next: TokenTotals | ((prev: TokenTotals) => TokenTotals)) => void;
  setMainLastContext: (
    next: ContextUsageSnapshot | ((prev: ContextUsageSnapshot) => ContextUsageSnapshot),
  ) => void;
}

export function createUsageSetters(): UsageSetters {
  return {
    setUsageByProvider: (next) => {
      if (typeof next === "function") {
        dispatch({ type: "usage/updateByProvider", updater: next });
      } else {
        dispatch({ type: "usage/setByProvider", value: next });
      }
    },
    setOfflineUsageByProvider: (next) => {
      if (typeof next === "function") {
        dispatch({ type: "usage/updateOfflineByProvider", updater: next });
      } else {
        dispatch({ type: "usage/setOfflineByProvider", value: next });
      }
    },
    setCodexUsage: (next) => {
      const value = typeof next === "function" ? next(appStore.getState().usage.codex) : next;
      dispatch({ type: "usage/setCodex", value });
    },
    setMainTokenTotals: (next) => {
      if (typeof next === "function") {
        dispatch({ type: "usage/updateMainTotals", updater: next });
      } else {
        dispatch({ type: "usage/setMainTotals", value: next });
      }
    },
    setMainLastContext: (next) => {
      const value =
        typeof next === "function" ? next(appStore.getState().usage.mainLastContext) : next;
      dispatch({ type: "usage/setMainLastContext", value });
    },
  };
}
