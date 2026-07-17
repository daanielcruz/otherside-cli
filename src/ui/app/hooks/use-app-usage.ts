import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef } from "react";
import { subscribeWorkflowCompletion } from "@/engine/background/workflows/runtime/store/store.ts";
import { autoRoutesNonVision, canSendNatively } from "@/engine/model/facts/capabilities-runtime.ts";
import { formatGoalStatusBar } from "@/engine/queue/runtime.ts";
import { getActiveGoal, restoreGoalFromRecords } from "@/engine/queue/state.ts";
import { estimateHarnessTokens } from "@/engine/session/compact/harness-baseline.ts";
import {
  getLastUsage,
  setEstimatedUsage,
  setLastUsage,
} from "@/engine/session/compact/last-usage.ts";
import { roughTokenCountEstimationForMessages } from "@/engine/session/compact/token-count.ts";
import {
  latestContextUsageSnapshotFromSessionRecords,
  type Session,
} from "@/engine/session/index.ts";
import { deriveChipUsage } from "@/engine/session/usage/chip-derive.ts";
import { createRecordProviderUsage } from "@/engine/session/usage/record-provider-usage.ts";
import {
  allTimeUsageByProviderAsync,
  mainTokenTotalsFromRecords,
  usageByProviderFromRecords,
} from "@/engine/session/usage/store.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import {
  GOAL_REFRESH_MS,
  RightNoticeKey,
  removePersistent,
  setTokenCounter,
  upsertPersistent,
} from "@/store/app-store/right-region-notices.ts";
import { appStore, dispatch, selectQueuedText, useAppSelect } from "@/store/index.ts";
import { computeAutoCompactRemainingPct } from "@/ui/app/status-text.ts";
import { createUsageSetters } from "@/ui/app/usage-setters.ts";
import { useClipboardImageHint } from "@/ui/hooks/use-clipboard-image-hint.ts";
import { estimateTokens } from "@/ui/transcript/stats.ts";
import type { TranscriptEntry } from "@/ui/transcript/types";

export interface AppUsageDeps {
  session: Session;
  broker: Broker;
  initialTranscript?: TranscriptEntry[] | undefined;
  state: ReturnType<Broker["read"]>;
  runtimeConfig: UserConfig;
}

export function useAppUsage(deps: AppUsageDeps) {
  const { session, broker, initialTranscript, state, runtimeConfig } = deps;
  const usageByProvider = useAppSelect((s) => s.usage.byProvider);
  const offlineUsageByProvider = useAppSelect((s) => s.usage.offlineByProvider);
  const codexUsage = useAppSelect((s) => s.usage.codex);
  const mainTokenTotals = useAppSelect((s) => s.usage.mainTotals);
  const mainLastContext = useAppSelect((s) => s.usage.mainLastContext);
  const {
    setUsageByProvider,
    setOfflineUsageByProvider,
    setCodexUsage,
    setMainTokenTotals,
    setMainLastContext,
  } = useMemo(() => createUsageSetters(), []);
  const seededMainContextRef = useRef(false);
  if (!seededMainContextRef.current) {
    seededMainContextRef.current = true;
    const baseline = estimateTokens(initialTranscript ?? [], "");
    if (baseline > 0) {
      setMainLastContext({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: baseline,
        cacheCreationInputTokens: 0,
      });
    }
  }
  const contextWarningSuppressed = useAppSelect((s) => s.view.contextWarningSuppressed);
  const refreshGeneration = useAppSelect((s) => s.rightRegion.refreshGeneration);
  const setContextWarningSuppressed = useCallback<Dispatch<SetStateAction<boolean>>>(
    (next): void => {
      const suppressed =
        typeof next === "function" ? next(appStore.getState().view.contextWarningSuppressed) : next;
      dispatch({ type: "view/setContextWarningSuppressed", suppressed });
    },
    [],
  );

  // Seed offline usage off the render path so a cold/large corpus cannot freeze the TUI.
  useEffect(() => {
    let alive = true;
    void allTimeUsageByProviderAsync()
      .then((offline) => {
        if (alive && Object.keys(offline).length > 0) {
          setOfflineUsageByProvider(offline);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [setOfflineUsageByProvider]);

  useEffect(() => {
    let alive = true;
    const restored = usageByProviderFromRecords([...session.records, ...session.usageRecords]);
    setUsageByProvider(restored);
    setMainTokenTotals(mainTokenTotalsFromRecords([...session.records, ...session.usageRecords]));
    void allTimeUsageByProviderAsync()
      .then((offline) => {
        if (alive) setOfflineUsageByProvider(offline);
      })
      .catch(() => {});
    restoreGoalFromRecords(session.id, session.records, session.hookEvents);
    const latestContextUsage = latestContextUsageSnapshotFromSessionRecords(
      session.records,
      {
        provider: broker.read().provider,
        model: broker.read().model,
      },
      session.usageRecords,
    );
    if (latestContextUsage) {
      setMainLastContext({
        inputTokens: latestContextUsage.inputTokens,
        outputTokens: latestContextUsage.outputTokens,
        cacheReadInputTokens: latestContextUsage.cacheReadInputTokens,
        cacheCreationInputTokens: latestContextUsage.cacheCreationInputTokens,
      });
      setLastUsage(latestContextUsage);
      return () => {
        alive = false;
      };
    }
    const existing = getLastUsage();
    if (!existing || (existing.inputTokens === 0 && existing.outputTokens === 0)) {
      const brokerNow = broker.read();
      const baseline =
        roughTokenCountEstimationForMessages(session.messages) +
        estimateHarnessTokens(brokerNow.provider, brokerNow.model);
      setMainLastContext({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: baseline,
        cacheCreationInputTokens: 0,
      });
      if (baseline > 0) {
        setEstimatedUsage({
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: baseline,
        });
      }
    }
    return () => {
      alive = false;
    };
  }, [
    session,
    broker,
    setMainTokenTotals,
    setUsageByProvider,
    setOfflineUsageByProvider,
    setMainLastContext,
  ]);

  const recordProviderUsage = useMemo(
    () =>
      createRecordProviderUsage({
        session,
        setMainTokenTotals,
        setMainLastContext,
        setContextWarningSuppressed,
        setUsageByProvider,
        setOfflineUsageByProvider,
      }),
    [
      session,
      setMainTokenTotals,
      setMainLastContext,
      setContextWarningSuppressed,
      setUsageByProvider,
      setOfflineUsageByProvider,
    ],
  );

  useEffect(
    () =>
      subscribeWorkflowCompletion((task) => {
        if (!task.provider || !task.model || task.totalTokens <= 0) return;
        // Completion-time rollup for out-of-process work. The meter is
        // output-only, attributed to the parent model; per-model split is the
        // upgrade path. isFork keeps it out of the main context totals while
        // still crediting the provider/cost ledger.
        recordProviderUsage(task.provider, task.model, 0, task.totalTokens, 0, 0, 0, {
          isFork: true,
        });
      }),
    [recordProviderUsage],
  );

  // Focus-gain clipboard probe publishes into the right-region ephemeral lane.
  const clipboardEnabled =
    canSendNatively(state.provider, state.model) ||
    autoRoutesNonVision(state.provider) ||
    Boolean(runtimeConfig.imageParserProvider);
  useClipboardImageHint(clipboardEnabled);

  const fallbackContextTokens = useMemo(
    () => roughTokenCountEstimationForMessages(session.messages),
    [session.messages.length],
  );
  const {
    contextBanner,
    activeContextTotal,
    autoCompactWarningPct,
    fallbackInputTokens,
    mainOutputTokens,
  } = deriveChipUsage({
    mainLastContext,
    mainTokenTotals,
    provider: state.provider,
    model: state.model,
    contextWarningSuppressed,
    fallbackContextTokens,
    queuedText: selectQueuedText(),
    autoCompactRemainingPct: (used) =>
      computeAutoCompactRemainingPct(used, state.model, state.provider),
  });

  // Publish persistent lane: context, auto-compact, goal, token counter.
  // refreshGeneration re-runs goal text on the shared region deadline.
  useEffect(() => {
    void refreshGeneration;
    if (contextBanner) {
      upsertPersistent({
        key: RightNoticeKey.context,
        text: contextBanner.message,
        tone: contextBanner.severity === "error" ? "error" : "warning",
        priority: "high",
      });
    } else {
      removePersistent(RightNoticeKey.context);
    }

    if (autoCompactWarningPct !== undefined) {
      upsertPersistent({
        key: RightNoticeKey.autoCompact,
        text: `${autoCompactWarningPct}% until auto-compact`,
        tone: "warning",
        priority: "medium",
      });
    } else {
      removePersistent(RightNoticeKey.autoCompact);
    }

    const goal = getActiveGoal(session.id);
    if (goal) {
      upsertPersistent({
        key: RightNoticeKey.goal,
        text: formatGoalStatusBar(goal),
        tone: "primary",
        priority: "low",
        refreshEveryMs: GOAL_REFRESH_MS,
      });
    } else {
      removePersistent(RightNoticeKey.goal);
    }

    if (activeContextTotal > 0) {
      setTokenCounter(`${activeContextTotal} tokens`);
    } else {
      setTokenCounter(null);
    }
  }, [refreshGeneration, contextBanner, autoCompactWarningPct, activeContextTotal, session.id]);

  return {
    usageByProvider,
    offlineUsageByProvider,
    codexUsage,
    mainTokenTotals,
    mainLastContext,
    setUsageByProvider,
    setOfflineUsageByProvider,
    setCodexUsage,
    setMainTokenTotals,
    setMainLastContext,
    contextWarningSuppressed,
    setContextWarningSuppressed,
    recordProviderUsage,
    activeContextTotal,
    autoCompactWarningPct,
    fallbackInputTokens,
    mainOutputTokens,
  };
}
