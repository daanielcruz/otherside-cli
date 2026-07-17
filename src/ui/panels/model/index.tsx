import { useEffect, useMemo, useState } from "react";
import { keptModelFeedback, setModelFeedback } from "@/commands/index.ts";
import {
  getProviderConfig,
  listProviderConfigs,
  providerSortRank,
} from "@/engine/contract/registry.ts";
import {
  availableModelsForProvider,
  findModel,
  modelDisplayWithContext,
} from "@/engine/model/catalog.ts";
import { Box, Text } from "@/ink";
import type { UserConfig } from "@/kernel/config/config.ts";
import { fastModeForProvider, updateConfig } from "@/kernel/config/config.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import {
  type CredentialsBundle,
  deleteFor,
  firstLoggedProvider,
  hasCredential,
  loadAll,
  type ProviderSlug,
} from "@/kernel/storage/credentials.ts";
import type { Broker } from "@/store/app-store/broker.ts";
import { readBrokerSlice, useAppSelect } from "@/store/index.ts";
import { FooterPanel, FooterPanelRow } from "@/ui/chrome/panel.tsx";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import { useOverlayDispatch, useOverlayState } from "@/ui/panels/context";
import { ProviderTosWarning } from "@/ui/panels/provider-tos-warning";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export interface ModelOverlayProps {
  broker?: Broker;
  config?: UserConfig;
  onClose?: () => void;
  onConfigChange?: ((config: UserConfig) => void) | undefined;
  onOpenLogin?: ((provider?: ProviderId) => void) | undefined;
  initialBundle?: CredentialsBundle | null;
  isTurnRunning?: (() => boolean) | undefined;
}

export function ModelOverlay({
  broker,
  config,
  onClose,
  onConfigChange,
  onOpenLogin,
  initialBundle,
  isTurnRunning,
}: ModelOverlayProps = {}): React.JSX.Element {
  const overlayState = useOverlayState();
  const dispatch = useOverlayDispatch();
  const activeBroker = broker ?? overlayState.broker;
  const activeConfigInit = config ?? overlayState.config;
  const close = useOverlayClose(onClose);
  const applyConfig = onConfigChange ?? dispatch.onConfigChange;
  const openLogin = onOpenLogin ?? dispatch.onOpenLogin;
  const state = useAppSelect((s) => readBrokerSlice(s.engine) ?? activeBroker.read());
  const [cfg, setCfg] = useState(activeConfigInit);
  const [bodyIdx, setBodyIdx] = useState(0);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [bundle, setBundle] = useState<CredentialsBundle | null>(initialBundle ?? null);
  const [phase, setPhase] = useState<"models" | "providers">("models");
  const [displayProvider, setDisplayProvider] = useState<ProviderId>(activeBroker.read().provider);

  useEffect(() => {
    void loadAll().then(setBundle);
  }, [actionMessage]);

  useEffect(() => {
    setDisplayProvider((current) => (phase === "models" ? current : current));
  }, [phase]);

  const provider = phase === "models" ? displayProvider : state.provider;
  const isLoggedIn = hasCredential(bundle, provider as ProviderSlug);
  const rows = useMemo(
    () => modelRows(provider, state.model, isLoggedIn),
    [provider, state.model, isLoggedIn],
  );
  const providerRows = useMemo(() => buildProviderPickerRows(), []);
  const selected = rows[bodyIdx];
  const selectedProvider = providerRows[bodyIdx];

  useEffect(() => {
    const len = phase === "providers" ? providerRows.length : rows.length;
    setBodyIdx((idx) => Math.min(idx, Math.max(0, len - 1)));
  }, [rows.length, providerRows.length, phase]);

  function openProviderPicker(): void {
    setPhase("providers");
    setBodyIdx(0);
  }

  function backToModels(): boolean {
    if (phase !== "providers") return false;
    setPhase("models");
    setBodyIdx(0);
    return true;
  }

  function chooseProvider(): void {
    if (!selectedProvider) return;
    setDisplayProvider(selectedProvider.id);
    setPhase("models");
    setBodyIdx(0);
  }

  function applyModelSelection(modelId: string): void {
    const fastMode = fastModeForProvider(cfg, provider);
    // Slip-direct: broker state is re-read on the next request, so applying
    // immediately is safe mid-turn.
    activeBroker.dispatch({ kind: "set_provider", provider, model: modelId, fastMode });
    const nextCfg = { ...cfg, defaultProvider: provider, defaultModel: modelId };
    setCfg(nextCfg);
    applyConfig?.(nextCfg);
    void updateConfig((current) => {
      current.defaultProvider = provider;
      current.defaultModel = modelId;
    });
    // Feedback mirrors the typed /model path byte-for-byte: bare displayName,
    // not the panel row label (which appends the context-window suffix).
    const display = findModel(modelId, provider)?.displayName ?? modelId;
    const isKept = modelId === state.model && provider === state.provider;
    const feedback = isKept ? keptModelFeedback(display) : setModelFeedback(display);
    dispatch.recordPanelCommit?.("model", feedback);
    close();
  }

  function activateModelRow(row: ModelRowEntry): void {
    if (row.kind === "model") {
      if (!isLoggedIn) {
        close();
        openLogin?.(provider);
        return;
      }
      const modelId = row.id.startsWith("model:") ? row.id.slice("model:".length) : row.id;
      applyModelSelection(modelId);
      return;
    }
    if (row.kind === "openai_config") {
      openLogin?.("openai");
      return;
    }
    if (row.kind === "login") {
      openLogin?.(row.provider);
      return;
    }
    if (row.kind === "change_provider") {
      openProviderPicker();
      return;
    }
    void removeProviderCredential(row.kind === "openai_delete");
  }

  async function removeProviderCredential(isOpenAiDelete: boolean): Promise<void> {
    if (!selected || selected.kind === "model" || selected.kind === "change_provider") return;
    if (selected.kind === "login" || selected.kind === "openai_config") return;
    const target = selected.provider;
    const wasActive = activeBroker.read().provider === target;
    setActionMessage(isOpenAiDelete ? "Deleting OpenAI Custom config…" : "Logging out…");
    try {
      await deleteFor(target);
      const fresh = await loadAll();
      setBundle(fresh);
      if (!wasActive) {
        setActionMessage(
          isOpenAiDelete
            ? "OpenAI Custom config deleted."
            : `Logged out from ${getProviderConfig(target)?.provider.label ?? target}.`,
        );
        return;
      }
      const next = firstLoggedProvider(fresh, target);
      if (!next) {
        setActionMessage("Logged out. No provider remaining — opening sign-in.");
        close();
        openLogin?.();
        return;
      }
      const rawDefault = getProviderConfig(next)?.defaultModelId;
      const nextModel = typeof rawDefault === "function" ? rawDefault() : (rawDefault ?? "");
      activeBroker.dispatch({
        kind: "set_provider",
        provider: next,
        model: nextModel,
        fastMode: fastModeForProvider(cfg, next),
      });
      const nextCfg = { ...cfg, defaultProvider: next, defaultModel: nextModel };
      setCfg(nextCfg);
      applyConfig?.(nextCfg);
      await updateConfig((current) => {
        current.defaultProvider = next;
        current.defaultModel = nextModel;
      });
      setActionMessage(
        `Logged out. Switched to ${getProviderConfig(next)?.provider.label ?? next}.`,
      );
      close();
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : String(err));
    }
  }

  usePanelNavigation({
    onClose: close,
    onBack: backToModels,
    rows: {
      count: phase === "providers" ? providerRows.length : rows.length,
      selected: bodyIdx,
      onChange: setBodyIdx,
    },
    onActivate: () => {
      if (phase === "providers") {
        chooseProvider();
        return;
      }
      if (selected) activateModelRow(selected);
    },
  });

  return (
    <FooterPanel
      command="/model"
      title={
        phase === "providers"
          ? "Choose a provider"
          : (getProviderConfig(provider)?.provider.label ?? provider)
      }
      footerHints={[
        ["↑↓", "navigate"],
        ["Enter", "select"],
        ["Esc", phase === "providers" ? "back" : "close"],
      ]}
    >
      {phase === "providers" ? (
        providerRows.map((row, index) => {
          const signedIn = hasCredential(bundle, row.id as ProviderSlug);
          return (
            <FooterPanelRow
              key={row.id}
              label={row.label}
              selected={index === bodyIdx}
              active={row.id === state.provider}
              width={42}
              {...(signedIn ? { value: `· ${Glyph.checkThin}`, valueColor: Color.success } : {})}
            />
          );
        })
      ) : rows.length === 0 ? (
        <Text color={Color.muted}>
          No models registered for {getProviderConfig(provider)?.provider.label ?? provider}
        </Text>
      ) : (
        <>
          {provider === "antigravity" && <ProviderTosWarning provider={provider} />}
          {rows.map((row, index) => {
            const prev = rows[index - 1];
            const separated =
              index > 0 &&
              prev !== undefined &&
              ((prev.kind === "model" && row.kind !== "model") || row.kind === "change_provider");
            return (
              <ModelRow key={row.id} row={row} selected={index === bodyIdx} separated={separated} />
            );
          })}
          {actionMessage !== null && (
            <Box marginTop={1}>
              <Text color={Color.muted}>{actionMessage}</Text>
            </Box>
          )}
        </>
      )}
    </FooterPanel>
  );
}

function buildProviderPickerRows(): { id: ProviderId; label: string }[] {
  return listProviderConfigs()
    .map((cfg) => cfg.provider.id)
    .sort((a, b) => providerSortRank(a) - providerSortRank(b))
    .map((id) => ({ id, label: getProviderConfig(id)?.provider.label ?? id }));
}

type ModelRowEntry =
  | { kind: "model"; id: string; label: string; active: boolean }
  | { kind: "logout"; id: string; label: string; provider: ProviderSlug }
  | { kind: "login"; id: string; label: string; provider: ProviderId }
  | { kind: "change_provider"; id: string; label: string }
  | { kind: "openai_config"; id: string; label: string }
  | { kind: "openai_delete"; id: string; label: string; provider: "openai" };

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
        label: `Log in to ${getProviderConfig(provider)?.provider.label ?? provider}`,
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
            kind: "model" as const,
            id: `model:${activeModel}`,
            label: activeModel || "Custom model",
            active: getProviderConfig(provider)?.allowsCustomModel === true,
          },
        ]
      : models.map((model) => ({
          kind: "model" as const,
          id: `model:${model.id}`,
          label: modelDisplayWithContext(model.id, provider),
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

function modelRowColor(kind: ModelRowEntry["kind"]) {
  if (kind === "logout" || kind === "openai_delete") return Color.fastMode;
  if (kind === "change_provider") return Color.steel;
  return Color.text;
}

function ModelRow({
  row,
  selected,
  separated,
}: {
  row: ModelRowEntry;
  selected: boolean;
  separated: boolean;
}): React.JSX.Element {
  if (row.kind === "model") {
    return <FooterPanelRow label={row.label} selected={selected} active={row.active} width={48} />;
  }

  const color = modelRowColor(row.kind);
  return (
    <Box marginTop={separated ? 1 : 0}>
      <Text color={color}>{selected ? Glyph.chevron : "  "}</Text>
      <Text color={color} bold={selected}>
        {row.label}
      </Text>
    </Box>
  );
}
