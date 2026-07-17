import { useEffect, useMemo, useRef, useState } from "react";
import { getProviderConfig, listProviderConfigs } from "@/engine/contract/registry.ts";
import {
  applyAnthropicUsageLimits,
  fetchAnthropicUsage,
} from "@/engine/providers/anthropic/usage.ts";
import {
  applyAntigravityQuotaWarning,
  fetchAntigravityUsage,
} from "@/engine/providers/antigravity/usage.ts";
import {
  applyCodexQuotaWarning,
  type CodexUsage,
  fetchCodexUsage,
} from "@/engine/providers/codex/usage.ts";
import { applyGlmQuotaWarning, fetchGlmUsage } from "@/engine/providers/glm/usage.ts";
import { applyKimiQuotaWarning, fetchKimiUsage } from "@/engine/providers/kimi/usage.ts";
import { applyMinimaxQuotaWarning, fetchMinimaxUsage } from "@/engine/providers/minimax/usage.ts";
import { applyXaiQuotaWarning, fetchXaiUsage } from "@/engine/providers/xai/usage.ts";
import type { Session } from "@/engine/session/index.ts";
import {
  getUsageLimitSnapshot,
  type RoutingUsageSnapshot,
  type UsageLimitSnapshot,
} from "@/engine/session/usage/limits.ts";
import {
  emptyProviderUsage,
  type ProviderUsageTotals,
  type UsageByProvider,
} from "@/engine/session/usage/provider.ts";
import { listProviderCooldowns } from "@/engine/session/usage/provider-health.ts";
import { Box, useTerminalDimensions } from "@/ink";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import {
  type CredentialsBundle,
  hasCredential,
  loadAll as loadCredentials,
  type ProviderSlug,
} from "@/kernel/storage/credentials.ts";
import type { Broker, BrokerState } from "@/store/app-store/broker.ts";
import { readBrokerSlice, readUsageLimitSnapshotSlice, useAppSelect } from "@/store/index.ts";
import { FooterPanel } from "@/ui/chrome/panel.tsx";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import {
  type AnthropicUsageLoadState,
  type AntigravityUsageLoadState,
  activityRows,
  blockedRoutingRows,
  type CodexUsageLoadState,
  cooldownRows,
  type DeepseekBalanceLoadState,
  initialTabIndex,
  type KimiUsageLoadState,
  type PlanQuotaLoadState,
  providerRows,
  totalUsage,
  type UsageInitialTab,
  type UsageTab,
  usageFooterHints,
  wrapIndex,
} from "@/ui/panels/usage/data";
import {
  AnthropicPlanUsage,
  AntigravityPlanUsage,
  CodexPlanUsage,
  DeepseekCombinedUsage,
  KimiCombinedUsage,
  LocalProviderUsage,
  PlanQuotaUsage,
} from "@/ui/panels/usage/plan-views";
import { UsageRows, UsageSection } from "@/ui/panels/usage/views";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";

export type {
  AnthropicUsageLoadState,
  AntigravityUsageLoadState,
  DeepseekBalanceLoadState,
  KimiUsageLoadState,
  UsageInitialTab,
  UsageTab,
};

export interface PendingProviderChange {
  kind: "set_model";
  provider: ProviderId;
  model: string;
  fastMode: boolean;
  persistDefault: boolean;
}

export interface UsageOverlayProps {
  broker: Broker;
  onClose: () => void;
  initialTab?: UsageInitialTab | undefined;
  command?: string | undefined;
  session?: Session | undefined;
  version?: string | undefined;
  usageByProvider?: UsageByProvider | undefined;
  offlineUsageByProvider?: UsageByProvider | undefined;
  codexUsage?: CodexUsage | null | undefined;
  onCodexUsage?: ((usage: CodexUsage | null) => void) | undefined;
  backgroundTaskCount?: number | undefined;
  anthropicUsageState?: AnthropicUsageLoadState | undefined;
  kimiUsageState?: KimiUsageLoadState | undefined;
  antigravityUsageState?: AntigravityUsageLoadState | undefined;
  config?: UserConfig | undefined;
  onConfigChange?: ((config: UserConfig) => void) | undefined;
  isTurnRunning?: (() => boolean) | undefined;
}

function usageProviderIds(): ProviderId[] {
  return listProviderConfigs()
    .map((c) => c.provider.id)
    .filter((id) => id !== "openai");
}

function usageTabsFor(providers: ProviderId[]): { id: UsageTab; label: string }[] {
  return [
    { id: "general", label: "General" },
    ...providers.map((id) => ({
      id,
      label: getProviderConfig(id)?.provider.label ?? id,
    })),
  ];
}

function providerDefaultModel(provider: ProviderId): string {
  const raw = getProviderConfig(provider)?.defaultModelId;
  return typeof raw === "function" ? raw() : (raw ?? "");
}

export function UsageOverlay({
  broker,
  onClose,
  initialTab = "general",
  command,
  usageByProvider = {},
  offlineUsageByProvider = {},
  codexUsage,
  onCodexUsage,
  anthropicUsageState: forcedAnthropicUsageState,
  kimiUsageState: forcedKimiUsageState,
  antigravityUsageState: forcedAntigravityUsageState,
}: UsageOverlayProps): React.JSX.Element {
  const close = useOverlayClose(onClose);
  const { columns } = useTerminalDimensions();
  const state = useAppSelect((s) => readBrokerSlice(s.engine) ?? broker.read());
  const [credentials, setCredentials] = useState<CredentialsBundle | null>(null);
  const [tabIdx, setTabIdx] = useState(() =>
    initialTabIndex(usageTabsFor([broker.read().provider]), initialTab, broker.read().provider),
  );
  const limitSnapshotSlice = useAppSelect((s) => readUsageLimitSnapshotSlice(s.engine));
  const limitSnapshot: UsageLimitSnapshot = limitSnapshotSlice ?? getUsageLimitSnapshot();
  const [anthropicUsageState, setAnthropicUsageState] = useState<AnthropicUsageLoadState>(
    forcedAnthropicUsageState ?? { status: "idle" },
  );
  const [codexUsageState, setCodexUsageState] = useState<
    | { status: "idle"; data: CodexUsage | null }
    | { status: "loading"; data: CodexUsage | null }
    | { status: "loaded"; data: CodexUsage | null }
    | { status: "error"; data: CodexUsage | null; message: string }
  >({ status: "idle", data: codexUsage ?? null });
  const [kimiUsageState, setKimiUsageState] = useState<KimiUsageLoadState>({
    ...(forcedKimiUsageState ?? { status: "idle", data: null }),
  });
  const [antigravityUsageState, setAntigravityUsageState] = useState<AntigravityUsageLoadState>(
    forcedAntigravityUsageState ?? { status: "idle", data: null },
  );
  const [glmUsageState, setGlmUsageState] = useState<PlanQuotaLoadState>({
    status: "idle",
    data: null,
  });
  const [minimaxUsageState, setMinimaxUsageState] = useState<PlanQuotaLoadState>({
    status: "idle",
    data: null,
  });
  const [xaiUsageState, setXaiUsageState] = useState<PlanQuotaLoadState>({
    status: "idle",
    data: null,
  });
  // Per-tab load generation. `r` bumps the active tab's counter so an in-flight
  // fetch's late resolve is dropped instead of clobbering the fresh one — and
  // bumping one tab never strands another tab's pending load.
  const loadGenRef = useRef<Partial<Record<UsageTab, number>>>({});

  useEffect(() => {
    let alive = true;
    void loadCredentials()
      .then((bundle) => {
        if (alive) setCredentials(bundle);
      })
      .catch(() => {
        if (alive) setCredentials({});
      });
    return () => {
      alive = false;
    };
  }, []);

  const eligibleProviders = useMemo<ProviderId[]>(() => {
    return usageProviderIds().filter((id) => hasCredential(credentials, id as ProviderSlug));
  }, [credentials]);

  const tabProviders = useMemo<ProviderId[]>(
    () =>
      usageProviderIds().filter((id) => id === state.provider || eligibleProviders.includes(id)),
    [eligibleProviders, state.provider],
  );
  const TABS = useMemo(() => usageTabsFor(tabProviders), [tabProviders]);

  const selectedTabIdRef = useRef<UsageTab>(TABS[tabIdx]?.id ?? "general");
  useEffect(() => {
    selectedTabIdRef.current = TABS[tabIdx]?.id ?? "general";
  });
  useEffect(() => {
    const idx = TABS.findIndex((tab) => tab.id === selectedTabIdRef.current);
    if (idx >= 0) setTabIdx(idx);
    else setTabIdx((i) => Math.min(i, TABS.length - 1));
  }, [TABS]);

  useEffect(() => {
    if (forcedAnthropicUsageState) setAnthropicUsageState(forcedAnthropicUsageState);
  }, [forcedAnthropicUsageState]);

  useEffect(() => {
    if (forcedKimiUsageState) setKimiUsageState(forcedKimiUsageState);
  }, [forcedKimiUsageState]);

  useEffect(() => {
    if (codexUsage) {
      applyCodexQuotaWarning(codexUsage);
      setCodexUsageState({ status: "loaded", data: codexUsage });
    }
  }, [codexUsage]);

  const activeTab = TABS[tabIdx]?.id ?? "general";
  const viewProvider: ProviderId = activeTab === "general" ? state.provider : activeTab;
  const maxContentWidth = Math.min(Math.max(24, columns - 8), 80);

  useEffect(() => {
    if (forcedAnthropicUsageState) return;
    if (activeTab === "general") return;
    if (!getProviderConfig(viewProvider)?.usageDetails?.hasPlanPanel) return;
    if (anthropicUsageState.status !== "idle") return;
    const gen = loadGenRef.current[activeTab] ?? 0;
    setAnthropicUsageState({ status: "loading" });
    void fetchAnthropicUsage()
      .then((data) => {
        if ((loadGenRef.current[activeTab] ?? 0) !== gen) return;
        applyAnthropicUsageLimits(data);
        setAnthropicUsageState({ status: "loaded", data });
      })
      .catch((err) => {
        if ((loadGenRef.current[activeTab] ?? 0) !== gen) return;
        setAnthropicUsageState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, [activeTab, forcedAnthropicUsageState, viewProvider, anthropicUsageState.status]);

  useEffect(() => {
    if (activeTab !== "codex" || codexUsageState.status !== "idle") return;
    const gen = loadGenRef.current[activeTab] ?? 0;
    setCodexUsageState({ status: "loading", data: null });
    void fetchCodexUsage()
      .then((data) => {
        if ((loadGenRef.current[activeTab] ?? 0) !== gen) return;
        applyCodexQuotaWarning(data);
        setCodexUsageState({ status: "loaded", data });
        onCodexUsage?.(data);
      })
      .catch((err) => {
        if ((loadGenRef.current[activeTab] ?? 0) !== gen) return;
        setCodexUsageState({
          status: "error",
          data: null,
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, [activeTab, onCodexUsage, codexUsageState.status]);

  useEffect(() => {
    if (forcedKimiUsageState) return;
    if (activeTab !== "kimi" || kimiUsageState.status !== "idle") return;
    const gen = loadGenRef.current[activeTab] ?? 0;
    setKimiUsageState({ status: "loading", data: null });
    void fetchKimiUsage()
      .then((data) => {
        if ((loadGenRef.current[activeTab] ?? 0) !== gen) return;
        applyKimiQuotaWarning(data);
        setKimiUsageState({ status: "loaded", data });
      })
      .catch((err) => {
        if ((loadGenRef.current[activeTab] ?? 0) !== gen) return;
        setKimiUsageState({
          status: "error",
          data: null,
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, [activeTab, forcedKimiUsageState, kimiUsageState.status]);

  useEffect(() => {
    if (forcedAntigravityUsageState) return;
    if (activeTab !== "antigravity" || antigravityUsageState.status !== "idle") return;
    const gen = loadGenRef.current[activeTab] ?? 0;
    setAntigravityUsageState({ status: "loading", data: null });
    void fetchAntigravityUsage()
      .then((data) => {
        if ((loadGenRef.current[activeTab] ?? 0) !== gen) return;
        applyAntigravityQuotaWarning(
          data,
          state.provider === "antigravity" ? state.model : providerDefaultModel("antigravity"),
        );
        setAntigravityUsageState({ status: "loaded", data });
      })
      .catch((err) => {
        if ((loadGenRef.current[activeTab] ?? 0) !== gen) return;
        setAntigravityUsageState({
          status: "error",
          data: null,
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, [
    activeTab,
    forcedAntigravityUsageState,
    antigravityUsageState.status,
    state.model,
    state.provider,
  ]);

  useEffect(() => {
    if (activeTab !== "glm" || glmUsageState.status !== "idle") return;
    const gen = loadGenRef.current[activeTab] ?? 0;
    setGlmUsageState({ status: "loading", data: null });
    void fetchGlmUsage()
      .then((data) => {
        if ((loadGenRef.current[activeTab] ?? 0) !== gen) return;
        applyGlmQuotaWarning(data);
        setGlmUsageState({ status: "loaded", data });
      })
      .catch((err) => {
        if ((loadGenRef.current[activeTab] ?? 0) !== gen) return;
        setGlmUsageState({
          status: "error",
          data: null,
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, [activeTab, glmUsageState.status]);

  useEffect(() => {
    if (activeTab !== "minimax" || minimaxUsageState.status !== "idle") return;
    const gen = loadGenRef.current[activeTab] ?? 0;
    setMinimaxUsageState({ status: "loading", data: null });
    void fetchMinimaxUsage()
      .then((data) => {
        if ((loadGenRef.current[activeTab] ?? 0) !== gen) return;
        applyMinimaxQuotaWarning(data);
        setMinimaxUsageState({ status: "loaded", data });
      })
      .catch((err) => {
        if ((loadGenRef.current[activeTab] ?? 0) !== gen) return;
        setMinimaxUsageState({
          status: "error",
          data: null,
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, [activeTab, minimaxUsageState.status]);

  useEffect(() => {
    if (activeTab !== "xai" || xaiUsageState.status !== "idle") return;
    const gen = loadGenRef.current[activeTab] ?? 0;
    setXaiUsageState({ status: "loading", data: null });
    void fetchXaiUsage()
      .then((data) => {
        if ((loadGenRef.current[activeTab] ?? 0) !== gen) return;
        applyXaiQuotaWarning(data);
        setXaiUsageState({ status: "loaded", data });
      })
      .catch((err) => {
        if ((loadGenRef.current[activeTab] ?? 0) !== gen) return;
        setXaiUsageState({
          status: "error",
          data: null,
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, [activeTab, xaiUsageState.status]);

  const total = useMemo(() => totalUsage(usageByProvider), [usageByProvider]);
  const offlineTotal = useMemo(() => totalUsage(offlineUsageByProvider), [offlineUsageByProvider]);

  const onAnthropicPlan =
    activeTab !== "general" && getProviderConfig(viewProvider)?.usageDetails?.hasPlanPanel === true;
  const refreshableTab =
    onAnthropicPlan ||
    activeTab === "codex" ||
    activeTab === "antigravity" ||
    activeTab === "kimi" ||
    activeTab === "glm" ||
    activeTab === "minimax" ||
    activeTab === "xai";

  const refreshActiveUsage = (): void => {
    // Bump this tab's generation so a still-in-flight fetch is superseded, then
    // force the tab back to idle to re-trigger its load effect — `r` restarts a
    // load even while one is running.
    loadGenRef.current[activeTab] = (loadGenRef.current[activeTab] ?? 0) + 1;
    if (onAnthropicPlan) {
      setAnthropicUsageState({ status: "idle" });
      return;
    }
    if (activeTab === "codex") {
      setCodexUsageState({ status: "idle", data: null });
    } else if (activeTab === "antigravity") {
      setAntigravityUsageState({ status: "idle", data: null });
    } else if (activeTab === "kimi") {
      setKimiUsageState({ status: "idle", data: null });
    } else if (activeTab === "glm") {
      setGlmUsageState({ status: "idle", data: null });
    } else if (activeTab === "minimax") {
      setMinimaxUsageState({ status: "idle", data: null });
    } else if (activeTab === "xai") {
      setXaiUsageState({ status: "idle", data: null });
    }
  };

  usePanelNavigation({
    onClose: close,
    onKey: (input, key) => {
      if (input === "r" && refreshableTab) {
        refreshActiveUsage();
        return true;
      }
      if (key.tab || key.leftArrow || key.rightArrow) {
        const delta = key.leftArrow ? -1 : 1;
        setTabIdx((i) => wrapIndex(i + delta, TABS.length));
        return true;
      }
      return false;
    },
  });

  return (
    <FooterPanel
      command={command ?? "/usage"}
      tabs={TABS.map((tab) => ({ label: tab.label }))}
      activeTab={tabIdx}
      tabsFocused
      onCancel={close}
      footerHints={usageFooterHints({
        activeTab,
        canScroll: false,
        canRefresh: refreshableTab,
      })}
    >
      {activeTab === "general" ? (
        <GeneralUsage
          total={total}
          offlineTotal={offlineTotal}
          usageByProvider={usageByProvider}
          offlineUsageByProvider={offlineUsageByProvider}
          routing={limitSnapshot.routing}
        />
      ) : (
        <Box flexDirection="column">
          <ProviderUsage
            provider={viewProvider}
            state={state}
            usage={usageByProvider[viewProvider] ?? emptyProviderUsage()}
            offlineUsage={offlineUsageByProvider[viewProvider] ?? emptyProviderUsage()}
            codexUsageState={codexUsageState}
            kimiUsageState={kimiUsageState}
            antigravityUsageState={antigravityUsageState}
            anthropicUsageState={anthropicUsageState}
            glmUsageState={glmUsageState}
            minimaxUsageState={minimaxUsageState}
            xaiUsageState={xaiUsageState}
            maxContentWidth={maxContentWidth}
          />
        </Box>
      )}
    </FooterPanel>
  );
}

function GeneralUsage({
  total,
  offlineTotal,
  usageByProvider,
  offlineUsageByProvider,
  routing,
}: {
  total: ProviderUsageTotals;
  offlineTotal: ProviderUsageTotals;
  usageByProvider: UsageByProvider;
  offlineUsageByProvider: UsageByProvider;
  routing: RoutingUsageSnapshot;
}): React.JSX.Element {
  const routingRows = [...cooldownRows(listProviderCooldowns()), ...blockedRoutingRows(routing)];
  return (
    <Box flexDirection="column">
      <UsageSection title="Current session (all providers)">
        <UsageRows rows={activityRows(total)} />
      </UsageSection>
      <UsageSection title="All time (all providers)" marginTop={1}>
        <UsageRows rows={activityRows(offlineTotal)} />
      </UsageSection>
      {routingRows.length > 0 && (
        <UsageSection title="Routing" marginTop={1}>
          <UsageRows rows={routingRows} />
        </UsageSection>
      )}
      <UsageSection title="Providers" marginTop={1}>
        <UsageRows rows={providerRows(usageByProvider, offlineUsageByProvider)} />
      </UsageSection>
    </Box>
  );
}

function ProviderUsage({
  provider,
  state,
  usage,
  offlineUsage,
  codexUsageState,
  kimiUsageState,
  antigravityUsageState,
  anthropicUsageState,
  glmUsageState,
  minimaxUsageState,
  xaiUsageState,
  maxContentWidth,
}: {
  provider: ProviderId;
  state: Readonly<BrokerState>;
  usage: ProviderUsageTotals;
  offlineUsage: ProviderUsageTotals;
  codexUsageState: CodexUsageLoadState;
  kimiUsageState: KimiUsageLoadState;
  antigravityUsageState: AntigravityUsageLoadState;
  anthropicUsageState: AnthropicUsageLoadState;
  glmUsageState: PlanQuotaLoadState;
  minimaxUsageState: PlanQuotaLoadState;
  xaiUsageState: PlanQuotaLoadState;
  maxContentWidth: number;
}): React.JSX.Element {
  const active = provider === state.provider;
  if (getProviderConfig(provider)?.usageDetails?.hasPlanPanel) {
    return (
      <AnthropicPlanUsage usageState={anthropicUsageState} maxContentWidth={maxContentWidth} />
    );
  }
  if (provider === "codex") {
    return <CodexPlanUsage usageState={codexUsageState} maxContentWidth={maxContentWidth} />;
  }
  if (provider === "antigravity") {
    return (
      <AntigravityPlanUsage
        usageState={antigravityUsageState}
        provider={provider}
        model={active ? state.model : (usage.lastModel ?? providerDefaultModel(provider))}
        usage={usage}
        offlineUsage={offlineUsage}
        maxContentWidth={maxContentWidth}
      />
    );
  }
  if (provider === "glm" || provider === "minimax" || provider === "xai") {
    const usageState =
      provider === "glm"
        ? glmUsageState
        : provider === "minimax"
          ? minimaxUsageState
          : xaiUsageState;
    return (
      <PlanQuotaUsage
        usageState={usageState}
        provider={provider}
        maxContentWidth={maxContentWidth}
      />
    );
  }
  if (provider === "kimi") {
    return <KimiCombinedUsage usageState={kimiUsageState} maxContentWidth={maxContentWidth} />;
  }
  if (provider === "deepseek") {
    return (
      <DeepseekCombinedUsage
        localUsage={usage}
        offlineUsage={offlineUsage}
        model={active ? state.model : (usage.lastModel ?? providerDefaultModel(provider))}
        maxContentWidth={maxContentWidth}
      />
    );
  }
  return (
    <LocalProviderUsage
      provider={provider}
      model={active ? state.model : (usage.lastModel ?? providerDefaultModel(provider))}
      usage={usage}
      offlineUsage={offlineUsage}
    />
  );
}
