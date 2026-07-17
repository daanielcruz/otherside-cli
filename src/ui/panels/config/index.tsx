import { useEffect, useMemo, useState } from "react";
import { listProviderConfigs } from "@/engine/contract/registry.ts";
import { availableModelsForProvider, defaultModelForProvider } from "@/engine/model/catalog.ts";
import {
  resolveParserModel,
  visionCapableProviderIds,
} from "@/engine/model/facts/capabilities-runtime.ts";
import { Box, Text } from "@/ink";
import type { UserConfig } from "@/kernel/config/config.ts";
import {
  effectiveOrchestrationMode,
  fastModeForProvider,
  normalizeWorkflowSizeGuideline,
  updateConfig,
} from "@/kernel/config/config.ts";
import {
  IMAGE_GENERATOR_PROVIDER_ID_VALUES,
  type ImageGeneratorSelection,
  type ProviderId,
  VOICE_PROVIDER_ID_VALUES,
  type VoiceProviderSelection,
} from "@/kernel/config/provider-ids.ts";
import type { PermissionMode } from "@/kernel/std/types/request.ts";
import {
  type CredentialsBundle,
  hasCredential,
  loadAll as loadCredentials,
  type ProviderSlug,
} from "@/kernel/storage/credentials.ts";
import type { Broker, BrokerState } from "@/store/app-store/broker.ts";
import { readBrokerSlice, useAppSelect } from "@/store/index.ts";
import { FooterPanel, FooterPanelRow } from "@/ui/chrome/panel.tsx";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import {
  applyConfigPatch,
  configPatch,
  cycle,
  cycleOrchestrationMode,
  filterRows,
  keyedRows,
  rowsFor,
  type SettingsRow,
  type TabId,
  WORKFLOW_SIZE_GUIDELINE_OPTIONS,
  wrapIndex,
} from "@/ui/panels/config/rows";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export interface ConfigOverlayProps {
  broker: Broker;
  config: UserConfig;
  version: string;
  onClose?: () => void;
  onOpenModel: () => void;
  initialTab?: TabId | undefined;
  onConfigChange?: ((config: UserConfig) => void) | undefined;
  isTurnRunning?: (() => boolean) | undefined;
}

export type { TabId } from "@/ui/panels/config/rows";

type Focus = "tabs" | "search" | "body" | "language";

export const CONFIG_TABS: { id: TabId; label: string }[] = [
  { id: "details", label: "Details" },
  { id: "config", label: "Config" },
];

const PERMISSION_MODES: PermissionMode[] = ["default", "accept-edits", "plan", "yolo"];
const LANGUAGE_PLACEHOLDER = "e.g., Japanese, 日本語, Español…";

export function ConfigOverlay({
  broker,
  config,
  version,
  onClose,
  onOpenModel,
  initialTab,
  onConfigChange,
  isTurnRunning,
}: ConfigOverlayProps): React.JSX.Element {
  const close = useOverlayClose(onClose);
  const state = useAppSelect((s) => readBrokerSlice(s.engine) ?? broker.read());
  const [cfg, setCfg] = useState(config);
  const [tabIdx, setTabIdx] = useState(() => {
    const idx = initialTab ? CONFIG_TABS.findIndex((tab) => tab.id === initialTab) : 1;
    return idx >= 0 ? idx : 1;
  });
  const [focus, setFocus] = useState<Focus>("tabs");
  const [query, setQuery] = useState("");
  const [rowIdx, setRowIdx] = useState(0);
  const [credentials, setCredentials] = useState<CredentialsBundle | null>(null);
  const [languageDraft, setLanguageDraft] = useState(config.language ?? "");

  useEffect(() => {
    let alive = true;
    void loadCredentials()
      .then((loaded) => {
        if (alive) setCredentials(loaded);
      })
      .catch(() => {
        if (alive) setCredentials({});
      });
    return () => {
      alive = false;
    };
  }, []);

  const [pendingProvider, setPendingProvider] = useState<{
    provider: ProviderId;
    model: string;
    fastMode: boolean;
  } | null>(null);

  const effectiveState: Readonly<BrokerState> = useMemo(
    () => (pendingProvider ? { ...state, ...pendingProvider } : state),
    [state, pendingProvider],
  );

  const rows = useMemo(
    () =>
      rowsFor({
        tab: CONFIG_TABS[tabIdx]?.id ?? "config",
        state: effectiveState,
        cfg,
        version,
        credentials,
      }),
    [tabIdx, effectiveState, cfg, version, credentials],
  );
  const filteredRows = useMemo(() => filterRows(rows, query), [rows, query]);
  const selectedRow = filteredRows[rowIdx];
  const activeTab = CONFIG_TABS[tabIdx]?.id ?? "config";
  const editingLanguage = focus === "language";
  const editingFreeText = editingLanguage;

  useEffect(() => {
    setRowIdx((idx) => Math.min(idx, Math.max(0, filteredRows.length - 1)));
  }, [filteredRows.length]);

  usePanelNavigation({
    onClose: close,
    onKey: (input, key) => {
      if (focus === "language") {
        if (key.return) {
          const next = { ...cfg };
          const trimmed = languageDraft.trim();
          if (trimmed) next.language = trimmed;
          else delete next.language;
          persist(next);
          setLanguageDraft(trimmed);
          setFocus("body");
          return true;
        }
        if (key.backspace || key.delete) {
          setLanguageDraft((value) => value.slice(0, -1));
          return true;
        }
        if (input && !key.ctrl && !key.meta) {
          setLanguageDraft((value) => value + input);
        }
        return true;
      }
      if (key.tab) {
        setTabIdx((i) => (i + 1) % CONFIG_TABS.length);
        setFocus("tabs");
        setRowIdx(0);
        return true;
      }
      if (key.leftArrow || key.rightArrow) {
        const delta = key.rightArrow ? 1 : -1;
        if (focus === "tabs") {
          setTabIdx((i) => wrapIndex(i + delta, CONFIG_TABS.length));
          setRowIdx(0);
          return true;
        }
        if (
          focus === "body" &&
          selectedRow &&
          selectedRow.kind !== "readonly" &&
          selectedRow.kind !== "modelPanel"
        ) {
          applyRow(selectedRow, delta);
          return true;
        }
        return true;
      }
      if (key.upArrow) {
        if (focus === "search") {
          setFocus("tabs");
        } else if (focus === "body") {
          if (activeTab === "details") {
            setFocus("tabs");
            return true;
          }
          if (rowIdx === 0) {
            setFocus("search");
          } else {
            setRowIdx((i) => Math.max(0, i - 1));
          }
        }
        return true;
      }
      if (key.downArrow) {
        if (focus === "tabs") {
          if (activeTab !== "config") return true;
          setFocus("search");
          setRowIdx(0);
        } else if (focus === "search") {
          setFocus("body");
          setRowIdx(0);
        } else {
          if (activeTab === "details") return true;
          setRowIdx((i) => Math.min(Math.max(0, filteredRows.length - 1), i + 1));
        }
        return true;
      }
      if (input === "/" && focus !== "search" && CONFIG_TABS[tabIdx]?.id === "config") {
        setFocus("search");
        return true;
      }
      if (focus === "search") {
        if (key.backspace || key.delete) {
          setQuery((q) => q.slice(0, -1));
          setRowIdx(0);
        } else if (input && !key.ctrl && !key.meta) {
          setQuery((q) => q + input);
          setRowIdx(0);
        }
        return true;
      }
      if (key.return) {
        if (selectedRow) applyRow(selectedRow, 0);
        return true;
      }
      if (input === " ") {
        if (selectedRow)
          applyRow(
            selectedRow,
            selectedRow.kind === "language" || selectedRow.kind === "modelPanel" ? 0 : 1,
          );
        return true;
      }
      return false;
    },
  });

  function persist(next: UserConfig): void {
    const patch = configPatch(cfg, next);
    setCfg(next);
    onConfigChange?.(next);
    void updateConfig((current) => {
      applyConfigPatch(current, patch);
    });
  }

  function commitAndClose(): void {
    if (pendingProvider) {
      const { provider, model, fastMode } = pendingProvider;
      // Slip-direct: broker state is re-read on the next request, so applying
      // immediately is safe mid-turn.
      broker.dispatch({ kind: "set_provider", provider, model, fastMode });
      persist({ ...cfg, defaultProvider: provider, defaultModel: model });
      setPendingProvider(null);
    }
    close();
  }

  function applyRow(row: SettingsRow, direction: number): void {
    switch (row.kind) {
      case "provider": {
        const eligible = listProviderConfigs()
          .map((c) => c.provider.id)
          .filter((id) => hasCredential(credentials, id as ProviderSlug));
        if (eligible.length === 0) break;
        const start = eligible.includes(effectiveState.provider)
          ? effectiveState.provider
          : eligible[0];
        if (!start) break;
        const provider = cycle(eligible, start, direction);
        const model = defaultModelForProvider(provider);
        const fastMode = fastModeForProvider(cfg, provider);
        const baseline = broker.read();
        if (
          provider === baseline.provider &&
          model === baseline.model &&
          fastMode === baseline.fastMode
        ) {
          setPendingProvider(null);
        } else {
          setPendingProvider({ provider, model, fastMode });
        }
        break;
      }
      case "model": {
        if (direction === 0) {
          onOpenModel();
          break;
        }
        const models = availableModelsForProvider(effectiveState.provider).map((m) => m.id);
        if (models.length === 0) break;
        const model = cycle(models, effectiveState.model, direction);
        const baseline = broker.read();
        const provider = effectiveState.provider;
        const fastMode = pendingProvider?.fastMode ?? baseline.fastMode;
        if (
          provider === baseline.provider &&
          model === baseline.model &&
          fastMode === baseline.fastMode
        ) {
          setPendingProvider(null);
        } else {
          setPendingProvider({ provider, model, fastMode });
        }
        break;
      }
      case "modelPanel": {
        if (direction === 0) onOpenModel();
        break;
      }
      case "permission": {
        const current = state.permissionMode;
        const mode = cycle(PERMISSION_MODES, current, direction);
        broker.dispatch({ kind: "set_permission_mode", mode });
        persist({ ...cfg, defaultMode: mode });
        break;
      }
      case "bool": {
        toggleBool(row.id, direction);
        break;
      }
      case "language": {
        if (direction === 0) {
          setLanguageDraft(cfg.language ?? "");
          setFocus("language");
        }
        break;
      }
      case "imageGeneratorProvider": {
        const configured = IMAGE_GENERATOR_PROVIDER_ID_VALUES.filter((provider) =>
          hasCredential(credentials, provider),
        );
        const current = cfg.imageGenProvider ?? "off";
        const options: ImageGeneratorSelection[] = ["off", ...configured];
        const next = cycle(options, current, direction || 1);
        const patch: UserConfig = { ...cfg, imageGenProvider: next };
        persist(patch);
        break;
      }
      case "voiceProvider": {
        const configured = VOICE_PROVIDER_ID_VALUES.filter((provider) =>
          hasCredential(credentials, provider),
        );
        const current = cfg.voiceProvider ?? "off";
        const options: VoiceProviderSelection[] = ["off", ...configured];
        if (!options.includes(current)) options.push(current);
        const next = cycle(options, current, direction || 1);
        const patch: UserConfig = { ...cfg };
        if (next === "off") delete patch.voiceProvider;
        else patch.voiceProvider = next;
        persist(patch);
        break;
      }
      case "imageParserProvider": {
        const eligible = visionCapableProviderIds()
          .filter((id) => id !== state.provider)
          .filter((id) => hasCredential(credentials, id as ProviderSlug));
        const options = ["off", ...eligible] as const;
        const current = cfg.imageParserProvider ?? "off";
        const next = cycle(options as readonly string[], current, direction || 1);
        const patch: UserConfig = { ...cfg };
        if (next === "off") {
          delete patch.imageParserProvider;
          delete patch.imageParserModel;
        } else {
          patch.imageParserProvider = next as ProviderId;
          patch.imageParserModel = resolveParserModel(next as ProviderId);
        }
        persist(patch);
        break;
      }
      case "imageParserModel": {
        const provider = cfg.imageParserProvider;
        if (!provider) break;
        const models = availableModelsForProvider(provider).map((m) => m.id);
        if (models.length === 0) break;
        const current = cfg.imageParserModel ?? resolveParserModel(provider);
        const next = cycle(models, current, direction || 1);
        persist({ ...cfg, imageParserModel: next });
        break;
      }
      case "workflowSizeGuideline": {
        const current = normalizeWorkflowSizeGuideline(cfg.workflowSizeGuideline);
        const next = cycle(WORKFLOW_SIZE_GUIDELINE_OPTIONS, current, direction || 1);
        persist({ ...cfg, workflowSizeGuideline: next });
        break;
      }
      case "readonly":
        break;
    }
  }

  function toggleBool(id: string | undefined, direction = 0): void {
    if (id === "fastMode") {
      const enabled = !state.fastMode;
      // Slip-direct: broker state is re-read on the next request.
      broker.dispatch({ kind: "set_fast_mode", enabled });
      persist({
        ...cfg,
        fastModeByProvider: { ...(cfg.fastModeByProvider ?? {}), [state.provider]: enabled },
      });
      return;
    }
    if (id === "autoCompact") persist({ ...cfg, autoCompact: !(cfg.autoCompact ?? true) });
    if (id === "showTips") persist({ ...cfg, showTips: !(cfg.showTips ?? true) });
    if (id === "parallelTasks") persist({ ...cfg, parallelTasks: !(cfg.parallelTasks ?? false) });
    if (id === "enableWorkflows") {
      persist({ ...cfg, enableWorkflows: !(cfg.enableWorkflows ?? true) });
    }
    if (id === "multiprovider") {
      const current = effectiveOrchestrationMode(cfg);
      const next = cycleOrchestrationMode(current, direction || 1);
      persist({ ...cfg, orchestrationMode: next });
    }
    if (id === "quotaFallback") persist({ ...cfg, quotaFallback: !(cfg.quotaFallback ?? true) });
    if (id === "chainOfCommand") {
      persist({ ...cfg, chainOfCommand: !(cfg.chainOfCommand ?? true) });
    }
  }

  const handleCancel = (): void => {
    if (focus === "language") {
      setLanguageDraft(cfg.language ?? "");
      setFocus("body");
      return;
    }
    if (focus === "search" && query.length > 0) {
      setQuery("");
      return;
    }
    commitAndClose();
  };

  return (
    <FooterPanel
      command="/config"
      tabs={CONFIG_TABS.map(({ label }) => ({ label }))}
      activeTab={tabIdx}
      tabsFocused={focus === "tabs"}
      search={
        activeTab === "config" && !editingFreeText
          ? { query, placeholder: "Search settings…", focused: focus === "search" }
          : undefined
      }
      footerHints={
        editingFreeText ? languageFooterHints() : footerHints(activeTab, focus, selectedRow)
      }
      onCancel={handleCancel}
    >
      {editingLanguage ? (
        <LanguageEditor draft={languageDraft} />
      ) : filteredRows.length === 0 ? (
        <Text color={Color.muted}>No settings match "{query}"</Text>
      ) : (
        keyedRows(filteredRows).map(({ row, position, key }) => {
          if (row.label.length === 0) return <Text key={key}> </Text>;
          if (row.kind === "modelPanel") {
            return <ModelPanelRow key={key} selected={focus === "body" && position === rowIdx} />;
          }
          return (
            <FooterPanelRow
              key={key}
              label={row.label}
              labelSuffix={row.labelSuffix}
              labelSuffixWidth={row.labelSuffixWidth}
              value={row.value}
              description={row.description}
              selected={focus === "body" && position === rowIdx}
              active={row.active}
              muted={row.muted}
              valueColor={row.valueColor}
            />
          );
        })
      )}
    </FooterPanel>
  );
}

function ModelPanelRow({ selected }: { selected: boolean }): React.JSX.Element {
  return (
    <Box>
      <Text color={selected ? Color.highlight : Color.steel}>
        {selected ? Glyph.chevron : "  "}
      </Text>
      <Text color={Color.steel} bold>
        More...
      </Text>
    </Box>
  );
}

function LanguageEditor({ draft }: { draft: string }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text color={Color.text}>Enter your preferred response and voice language:</Text>
      <Box marginTop={1}>
        <Text color={Color.chevron}>{Glyph.chevron}</Text>
        <LanguageInputValue value={draft} placeholder={LANGUAGE_PLACEHOLDER} />
      </Box>
      <Box marginTop={1}>
        <Text color={Color.muted}>Leave empty for default (English)</Text>
      </Box>
    </Box>
  );
}

function LanguageInputValue({
  value,
  placeholder,
}: {
  value: string;
  placeholder: string;
}): React.JSX.Element {
  if (value.length > 0) {
    return (
      <>
        <Text color={Color.text}>{value}</Text>
        <Text inverse> </Text>
      </>
    );
  }
  const [first = " ", ...rest] = [...placeholder];
  return (
    <>
      <Text inverse>{first}</Text>
      <Text color={Color.muted}>{rest.join("")}</Text>
    </>
  );
}

function languageFooterHints(): [string, string][] {
  return [
    ["Enter", "save"],
    ["Esc", "cancel"],
  ];
}

function footerHints(
  tab: TabId,
  focus: Focus,
  selectedRow: SettingsRow | undefined,
): [string, string][] {
  if (selectedRow?.kind === "modelPanel" && focus === "body") {
    const hints: [string, string][] = [
      ["↑↓", "move"],
      ["Enter/Space", "open /model"],
    ];
    if (tab === "config") hints.push(["/", "search"]);
    hints.push(["Esc", "close"]);
    return hints;
  }
  if (tab !== "config")
    return [
      ["←/→", "switch tabs"],
      ["Esc", "close"],
    ];
  if (focus === "tabs")
    return [
      ["←/→", "switch tabs"],
      ["↓", "settings"],
      ["Esc", "close"],
    ];
  if (focus === "search")
    return [
      ["Type", "filter"],
      ["Enter/↓", "select"],
      ["Esc", "clear"],
    ];
  return [
    ["↑↓", "move"],
    ["Enter/Space", "change"],
    ["/", "search"],
    ["Esc", "close"],
  ];
}
