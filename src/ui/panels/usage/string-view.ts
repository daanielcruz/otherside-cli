import { getProviderConfig, listProviderConfigs } from "@/engine/contract/registry.ts";
import type { AnthropicUsage } from "@/engine/providers/anthropic/usage.ts";
import type { AntigravityUsage } from "@/engine/providers/antigravity/usage.ts";
import { applyCodexQuotaWarning, type CodexUsage } from "@/engine/providers/codex/usage.ts";
import type { DeepseekBalance } from "@/engine/providers/deepseek/usage.ts";
import type { KimiUsage } from "@/engine/providers/kimi/usage.ts";
import {
  providerUsagePayload,
  QUOTA_MANUAL_REFRESH_MIN_INTERVAL_MS,
} from "@/engine/providers/quota-refresh.ts";
import { getUsageLimitSnapshot, type UsageLimitSnapshot } from "@/engine/session/usage/limits.ts";
import type { PlanQuotaData } from "@/engine/session/usage/plan-quota.ts";
import { emptyProviderUsage, type UsageByProvider } from "@/engine/session/usage/provider.ts";
import { listProviderCooldowns } from "@/engine/session/usage/provider-health.ts";
import { allTimeUsageByProviderAsync } from "@/engine/session/usage/store.ts";
import { errorMessage } from "@/kernel/std/errno.ts";
import { type ProviderId, providerDisplayName } from "@/kernel/std/types/provider-ids.ts";
import {
  type CredentialsBundle,
  hasCredential,
  loadAll as loadCredentials,
  type ProviderSlug,
} from "@/kernel/storage/credentials.ts";
import { appStore, dispatch } from "@/store/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import type { TerminalColor } from "@/terminal-runtime/text/style-model.js";
import { panelKey } from "@/ui/chrome/panel-keys.ts";
import { cycleTabForKey } from "@/ui/chrome/panel-tabs.ts";
import { readStringViewBrokerState } from "@/ui/chrome/status/string-view-state.ts";
import {
  FALLBACK_TERMINAL_ROWS,
  type FooterPanelSpec,
  renderFooterPanel,
  renderPanelRowLine,
} from "@/ui/chrome/string-view-panel.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import {
  type AnthropicUsageLoadState,
  type AntigravityUsageLoadState,
  activityRows,
  beginUsageLoad,
  blockedRoutingRows,
  type CodexUsageLoadState,
  cooldownRows,
  type DeepseekBalanceLoadState,
  failUsageLoad,
  initialUsageTab,
  type KimiUsageLoadState,
  type PlanQuotaLoadState,
  providerRows,
  restartUsageLoad,
  totalUsage,
  type UsageInitialTab,
  type UsageRow,
  type UsageTab,
  usageFooterHints,
  usageTabIndex,
} from "@/ui/panels/usage/data.ts";
import {
  anthropicPlanLines,
  antigravityPlanLines,
  codexPlanLines,
  deepseekLines,
  kimiPlanLines,
  localProviderLines,
  planQuotaLines,
} from "@/ui/panels/usage/plan-lines.ts";
import { Color } from "@/ui/theme/theme.ts";

/** Every panel load is user-initiated: refresh through the shared gate, serving cache within the manual window. */
const PANEL_REFRESH_OPTS = { maxAgeMs: QUOTA_MANUAL_REFRESH_MIN_INTERVAL_MS };
const CONTENT_PAD = 2;
const ROW_LABEL_WIDTH = 22;

interface UsagePanelProps {
  initialTab?: UsageInitialTab;
  command?: string;
}

/**
 * Tabbed provider usage / quota stats on the string model. General tab shows
 * session + all-time token totals, routing, and per-provider summary; each
 * provider tab surfaces plan quota bars (or local token/cost totals). ←/→ or
 * Tab cycles tabs; `r` refreshes the active plan surface; Escape closes.
 *
 * Slash-opened overlays carry no props — session usage, offline totals, codex
 * cache, and the usage-limit snapshot are read from the app store / engine SoT.
 */
class UsagePanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private unsub: (() => void) | undefined;
  private alive = true;

  private credentials: CredentialsBundle | null = null;
  private selectedTab: UsageTab;
  private readonly command: string;

  private anthropicUsageState: AnthropicUsageLoadState = { status: "idle", data: null };
  private codexUsageState: CodexUsageLoadState = { status: "idle", data: null };
  private kimiUsageState: KimiUsageLoadState = { status: "idle", data: null };
  private antigravityUsageState: AntigravityUsageLoadState = { status: "idle", data: null };
  private glmUsageState: PlanQuotaLoadState = { status: "idle", data: null };
  private minimaxUsageState: PlanQuotaLoadState = { status: "idle", data: null };
  private xaiUsageState: PlanQuotaLoadState = { status: "idle", data: null };
  private deepseekBalanceState: DeepseekBalanceLoadState = { status: "idle", data: null };

  /** Per-tab load generation — late resolves for a superseded fetch are dropped. */
  private readonly loadGen: Partial<Record<UsageTab, number>> = {};
  /** Local offline fallback when the store has not yet been hydrated. */
  private offlineFallback: UsageByProvider = {};

  constructor(
    private readonly close: () => void,
    props?: unknown,
  ) {
    const p = narrowProps(props);
    const broker = readStringViewBrokerState();
    this.selectedTab = initialUsageTab(p.initialTab ?? "general", broker.provider);
    this.command = p.command ?? "/usage";

    const codex = appStore.getState().usage.codex;
    if (codex) {
      applyCodexQuotaWarning(codex);
      this.codexUsageState = { status: "loaded", data: codex };
    }
  }

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    this.alive = true;
    this.unsub = appStore.subscribe(() => {
      this.ctx?.requestRender();
    });
    void this.loadCredentials();
    void this.hydrateOffline();
    this.ensureActiveLoads();
    ctx.requestRender();
  }

  unmount(): void {
    this.alive = false;
    this.unsub?.();
    this.unsub = undefined;
    this.ctx = undefined;
  }

  render(width: number): string[] {
    const tabs = this.tabs();
    const tabIdx = usageTabIndex(tabs, this.selectedTab);
    const activeTab = tabs[tabIdx]?.id ?? "general";
    this.selectedTab = activeTab;

    const contentWidth = Math.max(1, Math.floor(width) - CONTENT_PAD * 2);
    const maxContentWidth = Math.min(Math.max(24, Math.floor(width) - 8), 80);
    const body =
      activeTab === "general"
        ? this.generalBody(contentWidth)
        : this.providerBody(activeTab, contentWidth, maxContentWidth);

    const refreshable = this.isRefreshable(activeTab);
    const spec: FooterPanelSpec = {
      command: this.command,
      tabs: tabs.map((tab) => ({ label: tab.label })),
      activeTab: tabIdx,
      // Tabs are the panel's only focusable region, so the header always holds
      // focus and the active chip renders in the header-focus style.
      headerFocused: true,
      footerHints: usageFooterHints({ canRefresh: refreshable }),
      maxRows: this.terminalRows(),
      body,
    };
    return renderFooterPanel(spec, width);
  }

  handleKey(key: KeyEventData): void {
    const tabs = this.tabs();
    const tabIdx = usageTabIndex(tabs, this.selectedTab);
    const activeTab = tabs[tabIdx]?.id ?? "general";

    if (panelKey(key) === "close") {
      this.close();
      return;
    }

    if (key.sequence === "r" && this.isRefreshable(activeTab)) {
      this.refreshActiveUsage(activeTab);
      return;
    }

    const cycledTab = cycleTabForKey({
      key,
      activeTab: tabIdx,
      tabCount: tabs.length,
      headerFocused: true,
    });
    if (cycledTab !== undefined) {
      const next = tabs[cycledTab]?.id ?? "general";
      if (next !== this.selectedTab) {
        this.selectedTab = next;
        this.ensureActiveLoads();
        this.ctx?.requestRender();
      }
    }
  }

  private terminalRows(): number {
    return this.ctx?.terminalRows?.() ?? FALLBACK_TERMINAL_ROWS;
  }

  private tabs(): { id: UsageTab; label: string }[] {
    const state = readStringViewBrokerState();
    const eligible = usageProviderIds().filter((id) =>
      hasCredential(this.credentials, id as ProviderSlug),
    );
    const tabProviders = usageProviderIds().filter(
      (id) => id === state.provider || eligible.includes(id),
    );
    return [
      { id: "general", label: "General" },
      ...tabProviders.map((id) => ({ id, label: providerDisplayName(id) })),
    ];
  }

  private usageByProvider(): UsageByProvider {
    return appStore.getState().usage.byProvider;
  }

  private offlineUsageByProvider(): UsageByProvider {
    const store = appStore.getState().usage.offlineByProvider;
    return Object.keys(store).length > 0 ? store : this.offlineFallback;
  }

  private limitSnapshot(): UsageLimitSnapshot {
    return (
      (appStore.getState().engine.usageLimitSnapshot as UsageLimitSnapshot | undefined) ??
      getUsageLimitSnapshot()
    );
  }

  private generalBody(contentWidth: number): string[] {
    const usageByProvider = this.usageByProvider();
    const offlineUsageByProvider = this.offlineUsageByProvider();
    const total = totalUsage(usageByProvider);
    const offlineTotal = totalUsage(offlineUsageByProvider);
    const routingRows = [
      ...cooldownRows(listProviderCooldowns()),
      ...blockedRoutingRows(this.limitSnapshot().routing),
    ];

    const body: string[] = [];
    pushSection(body, "Current session (all providers)", activityRows(total), contentWidth);
    body.push("");
    pushSection(body, "All time (all providers)", activityRows(offlineTotal), contentWidth);
    if (routingRows.length > 0) {
      body.push("");
      pushSection(body, "Routing", routingRows, contentWidth);
    }
    body.push("");
    pushSection(
      body,
      "Providers",
      providerRows(usageByProvider, offlineUsageByProvider),
      contentWidth,
    );
    return body;
  }

  private providerBody(
    provider: ProviderId,
    contentWidth: number,
    maxContentWidth: number,
  ): string[] {
    const state = readStringViewBrokerState();
    const usage = this.usageByProvider()[provider] ?? emptyProviderUsage();
    const offlineUsage = this.offlineUsageByProvider()[provider] ?? emptyProviderUsage();
    const active = provider === state.provider;
    const model = active ? state.model : (usage.lastModel ?? providerDefaultModel(provider));

    if (getProviderConfig(provider)?.usageDetails?.hasPlanPanel) {
      return anthropicPlanLines(this.anthropicUsageState, maxContentWidth);
    }
    if (provider === "codex") {
      return codexPlanLines(this.codexUsageState, maxContentWidth);
    }
    if (provider === "antigravity") {
      return antigravityPlanLines(
        this.antigravityUsageState,
        provider,
        model,
        usage,
        offlineUsage,
        maxContentWidth,
        contentWidth,
      );
    }
    if (provider === "glm" || provider === "minimax" || provider === "xai") {
      const usageState =
        provider === "glm"
          ? this.glmUsageState
          : provider === "minimax"
            ? this.minimaxUsageState
            : this.xaiUsageState;
      return planQuotaLines(usageState, maxContentWidth);
    }
    if (provider === "kimi") {
      return kimiPlanLines(this.kimiUsageState, maxContentWidth);
    }
    if (provider === "deepseek") {
      return deepseekLines(this.deepseekBalanceState, usage, offlineUsage, model, contentWidth);
    }
    return localProviderLines(provider, model, usage, offlineUsage, contentWidth);
  }

  private isRefreshable(activeTab: UsageTab): boolean {
    if (activeTab === "general") return false;
    if (getProviderConfig(activeTab)?.usageDetails?.hasPlanPanel) return true;
    return (
      activeTab === "codex" ||
      activeTab === "antigravity" ||
      activeTab === "kimi" ||
      activeTab === "glm" ||
      activeTab === "minimax" ||
      activeTab === "xai" ||
      activeTab === "deepseek"
    );
  }

  private refreshActiveUsage(activeTab: UsageTab): void {
    this.loadGen[activeTab] = (this.loadGen[activeTab] ?? 0) + 1;
    if (activeTab !== "general" && getProviderConfig(activeTab)?.usageDetails?.hasPlanPanel) {
      this.anthropicUsageState = restartUsageLoad(this.anthropicUsageState);
    } else if (activeTab === "codex") {
      this.codexUsageState = restartUsageLoad(this.codexUsageState);
    } else if (activeTab === "antigravity") {
      this.antigravityUsageState = restartUsageLoad(this.antigravityUsageState);
    } else if (activeTab === "kimi") {
      this.kimiUsageState = restartUsageLoad(this.kimiUsageState);
    } else if (activeTab === "glm") {
      this.glmUsageState = restartUsageLoad(this.glmUsageState);
    } else if (activeTab === "minimax") {
      this.minimaxUsageState = restartUsageLoad(this.minimaxUsageState);
    } else if (activeTab === "xai") {
      this.xaiUsageState = restartUsageLoad(this.xaiUsageState);
    } else if (activeTab === "deepseek") {
      this.deepseekBalanceState = restartUsageLoad(this.deepseekBalanceState);
    }
    this.ensureActiveLoads();
    this.ctx?.requestRender();
  }

  private ensureActiveLoads(): void {
    const tabs = this.tabs();
    const tabIdx = usageTabIndex(tabs, this.selectedTab);
    const activeTab = tabs[tabIdx]?.id ?? "general";
    if (activeTab === "general") return;

    const viewProvider = activeTab;
    if (getProviderConfig(viewProvider)?.usageDetails?.hasPlanPanel) {
      if (this.anthropicUsageState.status === "idle") {
        void this.loadAnthropic(activeTab);
      }
      return;
    }
    if (activeTab === "codex" && this.codexUsageState.status === "idle") {
      void this.loadCodex(activeTab);
      return;
    }
    if (activeTab === "kimi" && this.kimiUsageState.status === "idle") {
      void this.loadKimi(activeTab);
      return;
    }
    if (activeTab === "antigravity" && this.antigravityUsageState.status === "idle") {
      void this.loadAntigravity(activeTab);
      return;
    }
    if (activeTab === "glm" && this.glmUsageState.status === "idle") {
      void this.loadPlanQuota("glm", activeTab, (next) => {
        this.glmUsageState = next;
      });
      return;
    }
    if (activeTab === "minimax" && this.minimaxUsageState.status === "idle") {
      void this.loadPlanQuota("minimax", activeTab, (next) => {
        this.minimaxUsageState = next;
      });
      return;
    }
    if (activeTab === "xai" && this.xaiUsageState.status === "idle") {
      void this.loadPlanQuota("xai", activeTab, (next) => {
        this.xaiUsageState = next;
      });
      return;
    }
    if (activeTab === "deepseek" && this.deepseekBalanceState.status === "idle") {
      void this.loadDeepseek(activeTab);
    }
  }

  private async loadCredentials(): Promise<void> {
    try {
      const bundle = await loadCredentials();
      if (!this.alive) return;
      this.credentials = bundle;
      this.ensureActiveLoads();
      this.ctx?.requestRender();
    } catch {
      if (!this.alive) return;
      this.credentials = {};
      this.ensureActiveLoads();
      this.ctx?.requestRender();
    }
  }

  private async hydrateOffline(): Promise<void> {
    try {
      const offline = await allTimeUsageByProviderAsync();
      if (!this.alive) return;
      this.offlineFallback = offline;
      const store = appStore.getState().usage.offlineByProvider;
      if (Object.keys(store).length === 0) {
        dispatch({ type: "usage/setOfflineByProvider", value: offline });
      }
      this.ctx?.requestRender();
    } catch {
      // leave store / fallback empty
    }
  }

  private async loadAnthropic(tab: UsageTab): Promise<void> {
    const gen = this.loadGen[tab] ?? 0;
    this.anthropicUsageState = beginUsageLoad(this.anthropicUsageState);
    this.ctx?.requestRender();
    try {
      const data = await providerUsagePayload<AnthropicUsage>("anthropic", PANEL_REFRESH_OPTS);
      if (!this.alive || (this.loadGen[tab] ?? 0) !== gen) return;
      this.anthropicUsageState = { status: "loaded", data };
    } catch (err) {
      if (!this.alive || (this.loadGen[tab] ?? 0) !== gen) return;
      this.anthropicUsageState = failUsageLoad(this.anthropicUsageState, errorMessage(err));
    }
    this.ctx?.requestRender();
  }

  private async loadCodex(tab: UsageTab): Promise<void> {
    const gen = this.loadGen[tab] ?? 0;
    this.codexUsageState = beginUsageLoad(this.codexUsageState);
    this.ctx?.requestRender();
    try {
      const data = await providerUsagePayload<CodexUsage>("codex", PANEL_REFRESH_OPTS);
      if (!this.alive || (this.loadGen[tab] ?? 0) !== gen) return;
      this.codexUsageState = { status: "loaded", data };
      dispatch({ type: "usage/setCodex", value: data });
    } catch (err) {
      if (!this.alive || (this.loadGen[tab] ?? 0) !== gen) return;
      this.codexUsageState = failUsageLoad(this.codexUsageState, errorMessage(err));
    }
    this.ctx?.requestRender();
  }

  private async loadKimi(tab: UsageTab): Promise<void> {
    const gen = this.loadGen[tab] ?? 0;
    this.kimiUsageState = beginUsageLoad(this.kimiUsageState);
    this.ctx?.requestRender();
    try {
      const data = await providerUsagePayload<KimiUsage>("kimi", PANEL_REFRESH_OPTS);
      if (!this.alive || (this.loadGen[tab] ?? 0) !== gen) return;
      this.kimiUsageState = { status: "loaded", data };
    } catch (err) {
      if (!this.alive || (this.loadGen[tab] ?? 0) !== gen) return;
      this.kimiUsageState = failUsageLoad(this.kimiUsageState, errorMessage(err));
    }
    this.ctx?.requestRender();
  }

  private async loadAntigravity(tab: UsageTab): Promise<void> {
    const gen = this.loadGen[tab] ?? 0;
    this.antigravityUsageState = beginUsageLoad(this.antigravityUsageState);
    this.ctx?.requestRender();
    try {
      const data = await providerUsagePayload<AntigravityUsage>("antigravity", PANEL_REFRESH_OPTS);
      if (!this.alive || (this.loadGen[tab] ?? 0) !== gen) return;
      this.antigravityUsageState = { status: "loaded", data };
    } catch (err) {
      if (!this.alive || (this.loadGen[tab] ?? 0) !== gen) return;
      this.antigravityUsageState = failUsageLoad(this.antigravityUsageState, errorMessage(err));
    }
    this.ctx?.requestRender();
  }

  private async loadPlanQuota(
    provider: "glm" | "minimax" | "xai",
    tab: UsageTab,
    setState: (next: PlanQuotaLoadState) => void,
  ): Promise<void> {
    const gen = this.loadGen[tab] ?? 0;
    const current =
      provider === "glm"
        ? this.glmUsageState
        : provider === "minimax"
          ? this.minimaxUsageState
          : this.xaiUsageState;
    setState(beginUsageLoad(current));
    this.ctx?.requestRender();
    try {
      const data = await providerUsagePayload<PlanQuotaData>(provider, PANEL_REFRESH_OPTS);
      if (!this.alive || (this.loadGen[tab] ?? 0) !== gen) return;
      setState({ status: "loaded", data });
    } catch (err) {
      if (!this.alive || (this.loadGen[tab] ?? 0) !== gen) return;
      const latest =
        provider === "glm"
          ? this.glmUsageState
          : provider === "minimax"
            ? this.minimaxUsageState
            : this.xaiUsageState;
      setState(failUsageLoad(latest, errorMessage(err)));
    }
    this.ctx?.requestRender();
  }

  private async loadDeepseek(tab: UsageTab): Promise<void> {
    const gen = this.loadGen[tab] ?? 0;
    this.deepseekBalanceState = beginUsageLoad(this.deepseekBalanceState);
    this.ctx?.requestRender();
    try {
      const data = await providerUsagePayload<DeepseekBalance>("deepseek", PANEL_REFRESH_OPTS);
      if (!this.alive || (this.loadGen[tab] ?? 0) !== gen) return;
      this.deepseekBalanceState = { status: "loaded", data };
    } catch (err) {
      if (!this.alive || (this.loadGen[tab] ?? 0) !== gen) return;
      this.deepseekBalanceState = failUsageLoad(this.deepseekBalanceState, errorMessage(err));
    }
    this.ctx?.requestRender();
  }
}

function usageProviderIds(): ProviderId[] {
  return listProviderConfigs()
    .map((c) => c.provider.id)
    .filter((id) => id !== "openai");
}

function providerDefaultModel(provider: ProviderId): string {
  const raw = getProviderConfig(provider)?.defaultModelId;
  return typeof raw === "function" ? raw() : (raw ?? "");
}

function pushSection(body: string[], title: string, rows: UsageRow[], contentWidth: number): void {
  body.push(renderTextWithStyles(title, { color: Color.text, bold: true }));
  for (const row of rows) {
    body.push(
      renderPanelRowLine(
        {
          label: row.label,
          value: row.value,
          muted: row.muted,
          valueColor: row.valueColor as TerminalColor | undefined,
        },
        contentWidth,
        ROW_LABEL_WIDTH,
      ),
    );
  }
}

function narrowProps(props: unknown): UsagePanelProps {
  if (typeof props !== "object" || props === null) return {};
  const record = props as Record<string, unknown>;
  const out: UsagePanelProps = {};
  if (typeof record.command === "string") out.command = record.command;
  if (
    record.initialTab === "general" ||
    record.initialTab === "per_provider" ||
    record.initialTab === "current" ||
    (typeof record.initialTab === "string" &&
      usageProviderIds().includes(record.initialTab as ProviderId))
  ) {
    out.initialTab = record.initialTab as UsageInitialTab;
  }
  return out;
}

export function createUsagePanel(close: () => void, props?: unknown): StringViewPanel {
  return new UsagePanel(close, props);
}

/** `/status` opens the usage panel on its account-wide tab. */
export function createStatusPanel(close: () => void): StringViewPanel {
  return new UsagePanel(close, { command: "/status", initialTab: "general" });
}

/** `/stats` opens the usage panel on the current-session tab. */
export function createStatsPanel(close: () => void): StringViewPanel {
  return new UsagePanel(close, { command: "/stats", initialTab: "current" });
}
