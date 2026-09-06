import { setModelFeedback } from "@/commands/index.ts";
import {
  getProviderConfig,
  listProviderConfigs,
  providerSortRank,
} from "@/engine/contract/registry.ts";
import {
  availableModelsForProvider,
  defaultEffortForModel,
  defaultModelForProvider,
  effortLevelsForModel,
  findModel,
  modelDisplayWithContext,
} from "@/engine/model/catalog.ts";
import { fastModeForProvider, loadConfigSync, updateConfig } from "@/kernel/config/config.ts";
import { type ProviderId, providerDisplayName } from "@/kernel/std/types/provider-ids.ts";
import {
  type CredentialsBundle,
  deleteFor,
  firstLoggedProvider,
  hasCredential,
  loadAll,
  type ProviderSlug,
} from "@/kernel/storage/credentials.ts";
import { getProcessBroker, reduce } from "@/store/app-store/broker.ts";
import { dispatch } from "@/store/app-store/index.ts";
import { overlayStack } from "@/store/overlay-stack/index.ts";
import { recordPanelCommitRef } from "@/store/turn-run/index.ts";
import type { KeyEventData } from "@/terminal-runtime/input/key-decoder.js";
import type { StringViewContext } from "@/terminal-runtime/string-view/component.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { listSelectKey } from "@/ui/chrome/list-select-keys.ts";
import { readStringViewBrokerState } from "@/ui/chrome/status/string-view-state.ts";
import {
  FALLBACK_TERMINAL_ROWS,
  type ListPanelSpec,
  listPanelPageSize,
  type PanelRowSpec,
  renderListPanel,
} from "@/ui/chrome/string-view-panel.ts";
import type { StringViewPanel } from "@/ui/panels/string-view-types.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

type Phase = "models" | "providers";

type ModelRowEntry =
  | { kind: "model"; id: string; label: string; active: boolean }
  | { kind: "logout"; id: string; label: string; provider: ProviderSlug }
  | { kind: "login"; id: string; label: string; provider: ProviderId }
  | { kind: "change_provider"; id: string; label: string }
  | { kind: "openai_config"; id: string; label: string }
  | { kind: "openai_delete"; id: string; label: string; provider: "openai" };

type ProviderPickerRow = { id: ProviderId; label: string };

const CATALOG = {
  findModel,
  effortLevelsForModel,
  defaultEffortForModel,
  defaultModelForProvider,
};

/**
 * Model picker on the string model. Lists the current display-provider's models
 * (context-window suffix + active mark), with a two-phase models↔providers flip
 * (Change provider → pick → return to that provider's models). Enter applies a
 * model (broker set_route + persist defaults) or opens login when the provider
 * has no credentials; Escape backs out of the provider list or closes.
 */
class ModelPanel implements StringViewPanel {
  private ctx: StringViewContext | undefined;
  private phase: Phase = "models";
  private cursor = 0;
  private displayProvider: ProviderId;
  private bundle: CredentialsBundle | null = null;
  private actionMessage: string | null = null;
  private cancelled = false;
  /** Rows the last frame showed at once; the page keys step by this. */
  private pageRows = 1;

  constructor(private readonly close: () => void) {
    this.displayProvider = readStringViewBrokerState().provider;
  }

  mount(ctx: StringViewContext): void {
    this.ctx = ctx;
    this.cancelled = false;
    void loadAll().then((bundle) => {
      if (this.cancelled) return;
      this.bundle = bundle;
      this.ctx?.requestRender();
    });
    ctx.requestRender();
  }

  unmount(): void {
    this.cancelled = true;
    this.ctx = undefined;
  }

  render(width: number): string[] {
    if (this.phase === "providers") {
      return this.renderProviders(width);
    }
    return this.renderModels(width);
  }

  handleKey(key: KeyEventData): void {
    const action = listSelectKey(key, {
      cursor: this.cursor,
      count: this.rowCount(),
      pageSize: this.pageRows,
    });
    if (action !== undefined) {
      this.cursor = action.cursor;
      this.ctx?.requestRender();
      if (action.activate) this.activate();
      return;
    }
    // The session pick applies the route and leaves the config alone.
    if (!key.ctrl && !key.meta && key.sequence === "s" && this.phase === "models") {
      this.selectForSession();
      return;
    }
    switch (key.name) {
      case "return":
        this.activate();
        return;
      case "escape":
        if (this.phase === "providers") {
          this.phase = "models";
          this.cursor = 0;
          this.ctx?.requestRender();
          return;
        }
        this.close();
        return;
    }
  }

  private renderModels(width: number): string[] {
    const broker = readStringViewBrokerState();
    const provider = this.displayProvider;
    const isLoggedIn = hasCredential(this.bundle, provider as ProviderSlug);
    const rows = modelRows(provider, broker.model, isLoggedIn);
    this.cursor = clampCursor(this.cursor, rows.length);

    const items = rows.map((row) => modelRowToItem(row));
    const spec: ListPanelSpec = {
      command: "/model",
      title: providerDisplayName(provider),
      items,
      cursor: this.cursor,
      maxRows: this.terminalRows(),
      emptyLabel: `No models registered for ${providerDisplayName(provider)}`,
      footerHints: [
        ["↑↓", "navigate"],
        ["Enter", "select"],
        ["s", "this session only"],
        ["Esc", "close"],
      ],
      rowWidth: 48,
    };
    if (this.actionMessage !== null) spec.subtitle = this.actionMessage;
    this.pageRows = listPanelPageSize(spec);
    return renderListPanel(spec, width);
  }

  private renderProviders(width: number): string[] {
    const broker = readStringViewBrokerState();
    const rows = buildProviderPickerRows();
    this.cursor = clampCursor(this.cursor, rows.length);

    const items = rows.map((row) => {
      const signedIn = hasCredential(this.bundle, row.id as ProviderSlug);
      const item: PanelRowSpec & { id: string } = {
        id: row.id,
        label: row.label,
        active: row.id === broker.provider,
      };
      if (signedIn) {
        item.value = `· ${Glyph.checkThin}`;
        item.valueColor = Color.success;
      }
      return item;
    });

    const spec: ListPanelSpec = {
      command: "/model",
      title: "Choose a provider",
      items,
      cursor: this.cursor,
      maxRows: this.terminalRows(),
      footerHints: [
        ["↑↓", "navigate"],
        ["Enter", "select"],
        ["Esc", "back"],
      ],
      rowWidth: 42,
    };
    if (this.actionMessage !== null) spec.subtitle = this.actionMessage;
    this.pageRows = listPanelPageSize(spec);
    return renderListPanel(spec, width);
  }

  private terminalRows(): number {
    return this.ctx?.terminalRows?.() ?? FALLBACK_TERMINAL_ROWS;
  }

  private rowCount(): number {
    return this.phase === "providers"
      ? buildProviderPickerRows().length
      : this.currentModelRows().length;
  }

  private currentModelRows(): ModelRowEntry[] {
    return modelRows(
      this.displayProvider,
      readStringViewBrokerState().model,
      hasCredential(this.bundle, this.displayProvider as ProviderSlug),
    );
  }

  /** `s`: route the session to the highlighted model without writing the default. */
  private selectForSession(): void {
    const provider = this.displayProvider;
    const row = this.currentModelRows()[this.cursor];
    if (row === undefined || row.kind !== "model") return;
    if (!hasCredential(this.bundle, provider as ProviderSlug)) return;
    const modelId = row.id.startsWith("model:") ? row.id.slice("model:".length) : row.id;
    this.applyModelSelection(provider, modelId, false);
  }

  private activate(): void {
    if (this.phase === "providers") {
      const row = buildProviderPickerRows()[this.cursor];
      if (!row) return;
      this.displayProvider = row.id;
      this.phase = "models";
      this.cursor = 0;
      this.actionMessage = null;
      this.ctx?.requestRender();
      return;
    }

    const broker = readStringViewBrokerState();
    const provider = this.displayProvider;
    const isLoggedIn = hasCredential(this.bundle, provider as ProviderSlug);
    const row = modelRows(provider, broker.model, isLoggedIn)[this.cursor];
    if (!row) return;
    this.activateModelRow(row);
  }

  private activateModelRow(row: ModelRowEntry): void {
    const provider = this.displayProvider;

    if (row.kind === "model") {
      if (!hasCredential(this.bundle, provider as ProviderSlug)) {
        this.close();
        overlayStack.open("login", { initialProvider: provider });
        return;
      }
      const modelId = row.id.startsWith("model:") ? row.id.slice("model:".length) : row.id;
      this.applyModelSelection(provider, modelId, true);
      return;
    }

    if (row.kind === "openai_config") {
      this.close();
      overlayStack.open("login", { initialProvider: "openai" });
      return;
    }

    if (row.kind === "login") {
      this.close();
      overlayStack.open("login", { initialProvider: row.provider });
      return;
    }

    if (row.kind === "change_provider") {
      this.phase = "providers";
      this.cursor = 0;
      this.actionMessage = null;
      this.ctx?.requestRender();
      return;
    }

    void this.removeProviderCredential(row.kind === "openai_delete");
  }

  /**
   * Applies a route. `persist` writes it back as the default for the next session;
   * without it the pick lives and dies with this one, and the feedback says so.
   */
  private applyModelSelection(provider: ProviderId, modelId: string, persist: boolean): void {
    const cfg = loadConfigSync();
    const fastMode = fastModeForProvider(cfg, provider);
    const previous = readStringViewBrokerState();
    applyBrokerRoute(provider, modelId, fastMode);
    if (persist) {
      void updateConfig((current) => {
        current.defaultProvider = provider;
        current.defaultModel = modelId;
      });
    }
    if (previous.provider !== provider || previous.model !== modelId) {
      const display = findModel({ provider, model: modelId })?.displayName ?? modelId;
      const feedback = setModelFeedback(display);
      recordPanelCommitRef.current(
        "model",
        persist ? feedback : `${feedback} for this session only`,
      );
    }
    this.close();
  }

  private async removeProviderCredential(isOpenAiDelete: boolean): Promise<void> {
    const broker = readStringViewBrokerState();
    const provider = this.displayProvider;
    const isLoggedIn = hasCredential(this.bundle, provider as ProviderSlug);
    const selected = modelRows(provider, broker.model, isLoggedIn)[this.cursor];
    if (!selected || selected.kind === "model" || selected.kind === "change_provider") return;
    if (selected.kind === "login" || selected.kind === "openai_config") return;

    const target = selected.provider;
    const wasActive = broker.provider === target;
    this.actionMessage = isOpenAiDelete ? "Deleting OpenAI Custom config…" : "Logging out…";
    this.ctx?.requestRender();

    try {
      await deleteFor(target);
      if (this.cancelled) return;
      const fresh = await loadAll();
      if (this.cancelled) return;
      this.bundle = fresh;

      if (!wasActive) {
        this.actionMessage = isOpenAiDelete
          ? "OpenAI Custom config deleted."
          : `Logged out from ${providerDisplayName(target)}.`;
        this.ctx?.requestRender();
        return;
      }

      const next = firstLoggedProvider(fresh, target);
      if (!next) {
        this.actionMessage = "Logged out. No provider remaining — opening sign-in.";
        this.ctx?.requestRender();
        this.close();
        overlayStack.open("login");
        return;
      }

      const nextModel = defaultModelForProvider(next);
      const cfg = loadConfigSync();
      applyBrokerRoute(next, nextModel, fastModeForProvider(cfg, next));
      void updateConfig((current) => {
        current.defaultProvider = next;
        current.defaultModel = nextModel;
      });
      const display = findModel({ provider: next, model: nextModel })?.displayName ?? nextModel;
      recordPanelCommitRef.current(
        "model",
        `Logged out from ${providerDisplayName(target)}. ${setModelFeedback(display)}`,
      );
      this.actionMessage = `Logged out. Switched to ${providerDisplayName(next)}.`;
      this.close();
    } catch (err) {
      if (this.cancelled) return;
      this.actionMessage = err instanceof Error ? err.message : String(err);
      this.ctx?.requestRender();
    }
  }
}

/**
 * Apply a {provider, model} route as a pair. Prefer the live process Broker so
 * turn dispatch (`broker.read()`) and the app-store mirror (status line via
 * startBrokerSubscriber) both see the change. Fall back to engine/setSlice when
 * no Broker is bound (unit tests / headless fixtures).
 */
function applyBrokerRoute(provider: ProviderId, model: string, fastMode: boolean): void {
  const event = {
    kind: "set_route" as const,
    route: { provider, model },
    fastMode,
  };
  const live = getProcessBroker();
  if (live !== undefined) {
    live.dispatch(event);
    return;
  }
  const next = reduce(readStringViewBrokerState(), event, CATALOG);
  dispatch({
    type: "engine/setSlice",
    key: "broker",
    value: next,
  });
}

function buildProviderPickerRows(): ProviderPickerRow[] {
  return listProviderConfigs()
    .map((cfg) => cfg.provider.id)
    .sort((a, b) => providerSortRank(a) - providerSortRank(b))
    .map((id) => ({ id, label: providerDisplayName(id) }));
}

function modelRows(
  provider: ProviderId,
  activeModel: string,
  isLoggedIn: boolean,
): ModelRowEntry[] {
  if (!isLoggedIn) {
    if (provider === "openai") {
      return [
        {
          kind: "openai_config",
          id: "openai:configure",
          label: "Configure OpenAI Custom",
        },
        {
          kind: "change_provider",
          id: "change_provider",
          label: "Change provider",
        },
      ];
    }
    return [
      {
        kind: "login",
        id: `login:${provider}`,
        label: `Log in to ${providerDisplayName(provider)}`,
        provider,
      },
      {
        kind: "change_provider",
        id: "change_provider",
        label: "Change provider",
      },
    ];
  }

  const models = availableModelsForProvider(provider);
  const baseRows: ModelRowEntry[] =
    models.length === 0
      ? [
          {
            kind: "model",
            id: `model:${activeModel}`,
            label: activeModel || "Custom model",
            active: getProviderConfig(provider)?.allowsCustomModel === true,
          },
        ]
      : models.map((model) => ({
          kind: "model" as const,
          id: `model:${model.id}`,
          label: modelDisplayWithContext({ provider, model: model.id }),
          active: model.id === activeModel,
        }));

  if (provider === "openai") {
    return [
      ...baseRows,
      {
        kind: "openai_config",
        id: "openai:change",
        label: "Change config",
      },
      {
        kind: "change_provider",
        id: "change_provider",
        label: "Change provider",
      },
      {
        kind: "openai_delete",
        id: "openai:delete",
        label: "Delete config",
        provider: "openai",
      },
    ];
  }

  return [
    ...baseRows,
    {
      kind: "change_provider",
      id: "change_provider",
      label: "Change provider",
    },
    {
      kind: "logout",
      id: `logout:${provider}`,
      label: "Log out",
      provider: provider as ProviderSlug,
    },
  ];
}

function modelRowToItem(row: ModelRowEntry): PanelRowSpec & { id: string } {
  if (row.kind === "model") {
    return {
      id: row.id,
      label: row.label,
      active: row.active,
    };
  }

  const color = modelRowColor(row.kind);
  return {
    id: row.id,
    label: row.label,
    styledLabel: renderTextWithStyles(row.label, { color }),
  };
}

function modelRowColor(kind: ModelRowEntry["kind"]) {
  if (kind === "logout" || kind === "openai_delete") return Color.fastMode;
  if (kind === "change_provider") return Color.steel;
  return Color.text;
}

function clampCursor(cursor: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, cursor));
}

export function createModelPanel(close: () => void, _props?: unknown): StringViewPanel {
  return new ModelPanel(close);
}
