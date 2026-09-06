import { setLastUsage } from "@/engine/session/compact/last-usage.ts";
import { appendUsageRecord, type Session } from "@/engine/session/index.ts";
import { nowIso } from "@/engine/session/record/schema.ts";
import {
  emptyProviderUsage,
  hasTokenUsage,
  type TokenTotals,
  type UsageByProvider,
} from "@/engine/session/usage/provider.ts";
import type { ContextUsageSnapshot } from "@/engine/session/usage/snapshot.ts";
import { usageRecordFromDelta } from "@/engine/session/usage/store.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";

export interface RecordProviderUsageDeps {
  session: Session;
  setMainTokenTotals: (updater: (current: TokenTotals) => TokenTotals) => void;
  setMainLastContext: (snapshot: ContextUsageSnapshot) => void;
  setContextWarningSuppressed: (suppressed: boolean) => void;
  setUsageByProvider: (updater: (prev: UsageByProvider) => UsageByProvider) => void;
  setOfflineUsageByProvider: (updater: (prev: UsageByProvider) => UsageByProvider) => void;
}

export interface RecordProviderUsageOptions {
  countRequest?: boolean;
  estimated?: boolean;
  isFork?: boolean;
  contextUsage?: ContextUsageSnapshot;
}

export type RecordProviderUsageFn = (
  provider: ProviderId,
  model: string,
  inputTokens?: number,
  outputTokens?: number,
  thoughtTokens?: number,
  cacheCreationInputTokens?: number,
  cacheReadInputTokens?: number,
  options?: RecordProviderUsageOptions,
) => void;

export function createRecordProviderUsage(deps: RecordProviderUsageDeps): RecordProviderUsageFn {
  const {
    session,
    setMainTokenTotals,
    setMainLastContext,
    setContextWarningSuppressed,
    setUsageByProvider,
    setOfflineUsageByProvider,
  } = deps;

  return function recordProviderUsage(
    provider: ProviderId,
    model: string,
    inputTokens = 0,
    outputTokens = 0,
    thoughtTokens = 0,
    cacheCreationInputTokens = 0,
    cacheReadInputTokens = 0,
    options?: RecordProviderUsageOptions,
  ): void {
    const countRequest = options?.countRequest ?? true;
    const isFork = options?.isFork ?? false;
    const usage: TokenTotals = {
      inputTokens: Math.max(0, Math.floor(inputTokens)),
      outputTokens: Math.max(0, Math.floor(outputTokens)),
      thoughtTokens: Math.max(0, Math.floor(thoughtTokens)),
      cacheCreationInputTokens: Math.max(0, Math.floor(cacheCreationInputTokens)),
      cacheReadInputTokens: Math.max(0, Math.floor(cacheReadInputTokens)),
    };
    const requestCount = countRequest ? 1 : 0;
    if (requestCount === 0 && !hasTokenUsage(usage)) return;
    if (hasTokenUsage(usage)) {
      if (!isFork) {
        setMainTokenTotals((current) => ({
          inputTokens: current.inputTokens + usage.inputTokens,
          outputTokens: current.outputTokens + usage.outputTokens,
          thoughtTokens: current.thoughtTokens + usage.thoughtTokens,
          cacheCreationInputTokens:
            current.cacheCreationInputTokens + usage.cacheCreationInputTokens,
          cacheReadInputTokens: current.cacheReadInputTokens + usage.cacheReadInputTokens,
        }));
        if (
          usage.inputTokens > 0 ||
          usage.cacheReadInputTokens > 0 ||
          usage.cacheCreationInputTokens > 0
        ) {
          const contextUsage = options?.contextUsage ?? usage;
          setMainLastContext({
            inputTokens: contextUsage.inputTokens,
            outputTokens: contextUsage.outputTokens,
            cacheCreationInputTokens: contextUsage.cacheCreationInputTokens,
            cacheReadInputTokens: contextUsage.cacheReadInputTokens,
          });
          setLastUsage({
            inputTokens: contextUsage.inputTokens,
            outputTokens: contextUsage.outputTokens,
            cacheCreationInputTokens: contextUsage.cacheCreationInputTokens,
            cacheReadInputTokens: contextUsage.cacheReadInputTokens,
          });
          if (!options?.estimated) {
            setContextWarningSuppressed(false);
          }
        }
      }
    }
    const addToProviderMap = (prev: UsageByProvider): UsageByProvider => {
      const current = prev[provider] ?? emptyProviderUsage();
      return {
        ...prev,
        [provider]: {
          requestCount: current.requestCount + requestCount,
          inputTokens: current.inputTokens + usage.inputTokens,
          outputTokens: current.outputTokens + usage.outputTokens,
          thoughtTokens: current.thoughtTokens + usage.thoughtTokens,
          cacheCreationInputTokens:
            (current.cacheCreationInputTokens ?? 0) + usage.cacheCreationInputTokens,
          cacheReadInputTokens: (current.cacheReadInputTokens ?? 0) + usage.cacheReadInputTokens,
          lastModel: model,
        },
      };
    };
    setUsageByProvider(addToProviderMap);
    const persistsOnAssistantRecord = !isFork && options?.estimated !== true;
    if (persistsOnAssistantRecord) {
      setOfflineUsageByProvider(addToProviderMap);
      return;
    }
    const at = nowIso();
    void appendUsageRecord(
      session,
      usageRecordFromDelta({
        provider,
        model,
        sessionId: session.id,
        usage,
        requestCount,
        at,
        estimated: options?.estimated,
        isSidechain: isFork,
      }),
    )
      .then(() => {
        setOfflineUsageByProvider(addToProviderMap);
      })
      .catch(() => {});
  };
}
