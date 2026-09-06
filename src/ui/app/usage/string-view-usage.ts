import { subscribeWorkflowCompletion } from "@/engine/background/workflows/runtime/store/store.ts";
import { restoreGoalFromRecords } from "@/engine/queue/state.ts";
import { estimateHarnessTokens } from "@/engine/session/compact/harness-baseline.ts";
import {
  getLastUsage,
  setEstimatedUsage,
  setLastUsage,
} from "@/engine/session/compact/last-usage.ts";
import { estimateConversationTokens } from "@/engine/session/compact/token-count.ts";
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
  RightNoticeKey,
  removePersistent,
  setTokenCounter,
  upsertPersistent,
} from "@/store/app-store/right-region-notices.ts";
import { appStore, dispatch, selectQueuedText } from "@/store/index.ts";
import { computeAutoCompactRemainingPct } from "@/ui/app/status-text.ts";
import { createUsageSetters } from "@/ui/app/usage-setters.ts";
import { estimateTokens } from "@/ui/transcript/stats.ts";
import type { TranscriptEntry } from "@/ui/transcript/types.ts";

export interface StringViewUsageDeps {
  session: Session;
  broker: Broker;
  initialTranscript?: readonly TranscriptEntry[] | undefined;
  runtimeConfig: UserConfig;
}

/**
 * Boots usage state for the string-view renderer (once) and keeps the token
 * counter + context/auto-compact/goal persistent notices derived from the usage
 * slice. Returns a teardown that unsubscribes store/workflow listeners.
 *
 * Port of the deleted React `useAppUsage` mount path: resume seed for
 * mainLastContext (status "% used") and publish of `setTokenCounter` (right
 * region "N tokens").
 */
export function activateStringViewUsage(deps: StringViewUsageDeps): () => void {
  const { session, broker, initialTranscript } = deps;
  const { setUsageByProvider, setOfflineUsageByProvider, setMainTokenTotals, setMainLastContext } =
    createUsageSetters();

  // Transcript-char baseline so a cold session shows a non-zero context before
  // the first provider usage lands; resume records overwrite this below.
  const transcriptBaseline = estimateTokens(initialTranscript ?? [], "");
  if (transcriptBaseline > 0) {
    setMainLastContext({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: transcriptBaseline,
      cacheCreationInputTokens: 0,
    });
  }

  const sessionUsageRecords = [...session.records, ...session.usageRecords];
  setUsageByProvider(usageByProviderFromRecords(sessionUsageRecords));
  setMainTokenTotals(mainTokenTotalsFromRecords(sessionUsageRecords));
  restoreGoalFromRecords(session.id, session.records, session.hookEvents);

  const brokerNow = broker.read();
  const latestContextUsage = latestContextUsageSnapshotFromSessionRecords(
    session.records,
    { provider: brokerNow.provider, model: brokerNow.model },
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
  } else {
    const existing = getLastUsage();
    if (!existing || (existing.inputTokens === 0 && existing.outputTokens === 0)) {
      const baseline =
        estimateConversationTokens(session.messages) +
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
  }

  // Offline corpus is scanned off the hot path so a cold/large history cannot
  // freeze the first frame.
  let offlineAlive = true;
  void allTimeUsageByProviderAsync()
    .then((offline) => {
      if (!offlineAlive) return;
      if (Object.keys(offline).length > 0) {
        setOfflineUsageByProvider(offline);
      }
    })
    .catch(() => {});

  const setContextWarningSuppressed = (suppressed: boolean): void => {
    dispatch({ type: "view/setContextWarningSuppressed", suppressed });
  };
  const recordProviderUsage = createRecordProviderUsage({
    session,
    setMainTokenTotals,
    setMainLastContext,
    setContextWarningSuppressed,
    setUsageByProvider,
    setOfflineUsageByProvider,
  });

  const unsubWorkflow = subscribeWorkflowCompletion((task) => {
    if (!task.provider || !task.model || task.totalTokens <= 0) return;
    // Completion-time rollup for out-of-process work. Output-only, attributed
    // to the parent model; isFork keeps it out of main context totals while
    // still crediting the provider/cost ledger.
    recordProviderUsage(task.provider, task.model, 0, task.totalTokens, 0, 0, 0, {
      isFork: true,
    });
  });

  const publishDerived = (): void => {
    const appState = appStore.getState();
    const brokerState = broker.read();
    const { contextBanner, activeContextTotal, autoCompactWarningPct } = deriveChipUsage({
      mainLastContext: appState.usage.mainLastContext,
      mainTokenTotals: appState.usage.mainTotals,
      provider: brokerState.provider,
      model: brokerState.model,
      contextWarningSuppressed: appState.view.contextWarningSuppressed,
      fallbackContextTokens: estimateConversationTokens(session.messages),
      queuedText: selectQueuedText(),
      autoCompactRemainingPct: (used) =>
        computeAutoCompactRemainingPct(used, brokerState.model, brokerState.provider),
    });

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

    setTokenCounter(activeContextTotal > 0 ? `${activeContextTotal} tokens` : null);
  };

  // Seed may already have written usage; publish immediately, then on changes.
  // rightRegion reducers no-op equal payloads, so re-entry is stable.
  publishDerived();
  const unsubStore = appStore.subscribe(publishDerived);
  const unsubBroker = broker.subscribe(() => {
    publishDerived();
  });

  return () => {
    offlineAlive = false;
    unsubWorkflow();
    unsubStore();
    unsubBroker();
  };
}
