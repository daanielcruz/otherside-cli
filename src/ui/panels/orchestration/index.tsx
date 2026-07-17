import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { useMemo, useState } from "react";
import { TIER_NAMES, type TierName } from "@/engine/model/tier/names.ts";
import {
  type RosterEntry,
  type RosterScope,
  readScopedOverlay,
  reloadRosterOverlay,
  scopedOrchestrationPath,
  writeScopedTier,
} from "@/engine/model/tier/roster-overlay.ts";
import { seedTierRoster } from "@/engine/model/tier/tiers.ts";
import { Box, Text } from "@/ink";
import {
  effectiveOrchestrationMode,
  type UserConfig,
  updateConfig,
} from "@/kernel/config/config.ts";
import type { OrchestrationMode } from "@/kernel/config/orchestration-mode.ts";
import { isProviderId } from "@/kernel/config/provider-ids.ts";
import { type EditorLaunch, openPathInEditor } from "@/kernel/std/proc/editor-launch.ts";
import { FooterPanel, FooterPanelRow, PanelColor } from "@/ui/chrome/panel.tsx";
import { usePanelNavigation } from "@/ui/hooks/use-panel-navigation.ts";
import { cycleOrchestrationMode } from "@/ui/panels/config/rows.ts";
import { useOverlayClose } from "@/ui/panels/use-overlay-close";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export interface OrchestrationOverlayProps {
  config: UserConfig;
  cwd: string;
  onClose?: () => void;
  onConfigChange?: ((config: UserConfig) => void) | undefined;
}

type View = { kind: "root" } | { kind: "tier"; tier: TierName } | { kind: "json-info" };

const MODE_VALUE: Record<OrchestrationMode, string> = {
  disabled: "Disabled",
  default: "Default",
  feudalism: "Feudalism",
};

const MODE_DESCRIPTION: Record<OrchestrationMode, string> = {
  disabled: "agents use your current model",
  default: "agents pick from the model catalog",
  feudalism: "four tiers, each with its own lineup",
};

const TIER_LABEL: Record<TierName, string> = {
  emperor: "Emperor — deep reasoning",
  shogun: "Shogun — complex work",
  daimyo: "Daimyo — everyday tasks",
  samurai: "Samurai — bulk work",
};

const TIER_ROLE_SENTENCE: Record<TierName, string> = {
  emperor: "Deep reasoning for the hardest problems.",
  shogun: "Complex work that needs judgment.",
  daimyo: "Fast, capable everyday work.",
  samurai: "Simple bulk work, fanned out in parallel.",
};

const LINEUP_SENTENCE = "The first model that works is used; the rest are backups, in order.";
const TIERS_HEADING = "Tiers — press Enter to edit a lineup";
const ADD_ROW_LABEL = "+ Add a model";
const ADD_ROW_DESCRIPTION = "type the provider, then the model";
const DRAFT_GUIDE =
  'For example "anthropic claude-opus-4-6" — provider first, then a space, then the model.';
const DRAFT_INVALID = "That doesn't look right — type the provider, a space, then the model.";
const EMPTY_TIER_NOTE = "This tier is turned off — no models in its lineup.";
const IDLE_NOTE_LINES = [
  "Nothing to set up in this mode.",
  "Switch the mode to Feudalism to choose which models each tier of agents uses.",
] as const;
const JSON_EXAMPLE = `{
  "tiers": {
    "emperor": [
      { "provider": "anthropic", "model": "claude-opus-4-6" }
    ]
  }
}`;
const JSON_HELP_LINES = [
  "The first model listed is the first choice; the rest are backups, in order.",
  "Leave a tier out to keep its built-in lineup. An empty list turns the tier off.",
  "Changes are picked up automatically the next time agents run.",
] as const;

interface TierRoster {
  entries: RosterEntry[];
  overridden: boolean;
}

export function OrchestrationOverlay({
  config,
  cwd,
  onClose,
  onConfigChange,
}: OrchestrationOverlayProps): React.JSX.Element {
  const close = useOverlayClose(onClose);
  const [cfg, setCfg] = useState<UserConfig>(config);
  const [scope, setScope] = useState<RosterScope>("user");
  const [view, setView] = useState<View>({ kind: "root" });
  const [selected, setSelected] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const [draftInvalid, setDraftInvalid] = useState(false);
  const [launch, setLaunch] = useState<EditorLaunch | null>(null);
  const [revision, setRevision] = useState(0);

  const mode = effectiveOrchestrationMode(cfg);
  // revision invalidates the memo after every roster write.
  const rosters = useMemo(() => {
    void revision;
    const byTier = {} as Record<TierName, TierRoster>;
    const scoped = readScopedOverlay(scope, cwd);
    for (const tier of TIER_NAMES) {
      const override = scoped[tier];
      byTier[tier] =
        override !== undefined
          ? { entries: override, overridden: true }
          : {
              entries: seedTierRoster(tier).map((m) => ({ provider: m.provider, model: m.name })),
              overridden: false,
            };
    }
    return byTier;
  }, [scope, cwd, revision]);

  const persistMode = (next: OrchestrationMode): void => {
    const updated = { ...cfg, orchestrationMode: next };
    setCfg(updated);
    void updateConfig((current) => {
      current.orchestrationMode = next;
    });
    onConfigChange?.(updated);
  };

  const writeTier = (tier: TierName, entries: RosterEntry[] | null): void => {
    writeScopedTier(scope, cwd, tier, entries);
    reloadRosterOverlay(cwd);
    setRevision((n) => n + 1);
  };

  const commitDraft = (tier: TierName): void => {
    const text = (draft ?? "").trim();
    const [provider, ...rest] = text.split(/[\s/]+/);
    const model = rest.join("/");
    if (!isProviderId(provider) || model.trim().length === 0) {
      setDraftInvalid(true);
      return;
    }
    setDraft(null);
    setDraftInvalid(false);
    writeTier(tier, [...rosters[tier].entries, { provider, model }]);
  };

  // Root rows: mode, then (feudalism only) scope + one row per tier + edit-json.
  const rootRowCount = mode === "feudalism" ? 2 + TIER_NAMES.length + 1 : 1;
  const tierRowCount = (tier: TierName): number => rosters[tier].entries.length + 1;
  const rowCount = view.kind === "tier" ? tierRowCount(view.tier) : rootRowCount;
  const sel = Math.min(selected, rowCount - 1);

  const enterJsonEdit = (): void => {
    const path = scopedOrchestrationPath(scope, cwd);
    const result = openPathInEditor(path);
    setLaunch(result);
    if (!result.ok) setView({ kind: "json-info" });
  };

  const activateRoot = (): void => {
    if (sel === 0) {
      persistMode(cycleOrchestrationMode(mode, 1));
      return;
    }
    if (mode !== "feudalism") return;
    if (sel === 1) {
      setScope((s) => (s === "user" ? "project" : "user"));
      return;
    }
    const tier = TIER_NAMES[sel - 2];
    if (tier !== undefined) {
      setView({ kind: "tier", tier });
      setSelected(0);
      return;
    }
    enterJsonEdit();
  };

  const activateTier = (tier: TierName): void => {
    if (sel === rosters[tier].entries.length) setDraft("");
  };

  usePanelNavigation({
    onClose: close,
    onActivate:
      draft === null
        ? () => (view.kind === "tier" ? activateTier(view.tier) : activateRoot())
        : undefined,
    onBack: () => {
      if (draft !== null) {
        setDraft(null);
        setDraftInvalid(false);
        return true;
      }
      if (view.kind !== "root") {
        setView({ kind: "root" });
        setSelected(0);
        setLaunch(null);
        return true;
      }
      return false;
    },
    rows: { count: rowCount, selected: sel, onChange: draft === null ? setSelected : () => {} },
    onKey: (input, key) => {
      if (draft !== null && view.kind === "tier") {
        if (key.return) {
          commitDraft(view.tier);
          return true;
        }
        if (key.backspace || key.delete) {
          setDraft((d) => (d ?? "").slice(0, -1));
          setDraftInvalid(false);
          return true;
        }
        if (input && !key.ctrl && !key.meta) {
          setDraft((d) => (d ?? "") + input);
          setDraftInvalid(false);
          return true;
        }
        return true;
      }
      if (view.kind === "tier") {
        const tier = view.tier;
        const entries = [...rosters[tier].entries];
        const onEntry = sel < entries.length;
        if (input === "x" && onEntry) {
          entries.splice(sel, 1);
          writeTier(tier, entries);
          return true;
        }
        if ((input === "+" || input === "=") && onEntry && sel > 0) {
          const moved = entries.splice(sel, 1)[0] as RosterEntry;
          entries.splice(sel - 1, 0, moved);
          writeTier(tier, entries);
          setSelected(sel - 1);
          return true;
        }
        if (input === "-" && onEntry && sel < entries.length - 1) {
          const moved = entries.splice(sel, 1)[0] as RosterEntry;
          entries.splice(sel + 1, 0, moved);
          writeTier(tier, entries);
          setSelected(sel + 1);
          return true;
        }
        if (input === "r" && rosters[tier].overridden) {
          writeTier(tier, null);
          setSelected(0);
          return true;
        }
      }
      if (view.kind === "root" && mode === "feudalism" && input === "s") {
        setScope((s) => (s === "user" ? "project" : "user"));
        return true;
      }
      return false;
    },
  });

  const scopePath = scopedOrchestrationPath(scope, cwd);

  if (view.kind === "json-info") {
    return (
      <FooterPanel
        command="/orchestration"
        title="Orchestration — Edit as JSON"
        footerHints={[["Esc", "back"]]}
        disableCancelKey
      >
        <Box flexDirection="column" gap={1}>
          <Text color={Color.text}>{launchFailureMessage(launch)}</Text>
          <Box flexDirection="column">
            <Text color={Color.text}>You can edit the file by hand:</Text>
            <Box paddingLeft={2}>
              <Text color={Color.primary}>{displayPath(scopePath)}</Text>
            </Box>
          </Box>
          <Box flexDirection="column">
            <Text color={Color.text}>Example:</Text>
            <Box paddingLeft={2}>
              <Text color={Color.muted}>{JSON_EXAMPLE}</Text>
            </Box>
          </Box>
          <Box flexDirection="column">
            {JSON_HELP_LINES.map((line) => (
              <Text key={line} color={Color.muted}>
                {line}
              </Text>
            ))}
          </Box>
        </Box>
      </FooterPanel>
    );
  }

  if (view.kind === "tier") {
    const tier = view.tier;
    const roster = rosters[tier];
    const onAddRow = sel === roster.entries.length;
    // Rank is the row identity: the label ("First choice" / "Backup N") is
    // unique per position even when the same model appears twice.
    const entryRows = roster.entries.map((entry, index) => ({
      entry,
      label: entryLabel(index),
      selected: sel === index,
    }));
    return (
      <FooterPanel
        command="/orchestration"
        title={`Orchestration — ${titleCase(tier)}`}
        subtitle={
          <Box flexDirection="column">
            <Text dim>{`${TIER_ROLE_SENTENCE[tier]} ${LINEUP_SENTENCE}`}</Text>
            <Text color={Color.muted}>Edits write {displayPath(scopePath)}</Text>
          </Box>
        }
        footerHints={tierFooterHints(draft !== null, onAddRow, roster.overridden)}
        {...(draft !== null ? { inputGuide: DRAFT_GUIDE } : {})}
        disableCancelKey
      >
        <Box flexDirection="column">
          {entryRows.map((row) => (
            <FooterPanelRow
              key={row.label}
              label={row.label}
              value={row.entry.model}
              description={row.entry.provider}
              selected={row.selected}
            />
          ))}
          {roster.entries.length === 0 && (
            <Box paddingLeft={2} marginBottom={1}>
              <Text color={Color.muted}>{EMPTY_TIER_NOTE}</Text>
            </Box>
          )}
          {draft === null ? (
            <FooterPanelRow
              label={ADD_ROW_LABEL}
              description={ADD_ROW_DESCRIPTION}
              selected={onAddRow}
              muted={!onAddRow}
            />
          ) : (
            <DraftRow draft={draft} />
          )}
          {draftInvalid && (
            <Box paddingLeft={2} marginTop={1}>
              <Text color={Color.warning}>{DRAFT_INVALID}</Text>
            </Box>
          )}
        </Box>
      </FooterPanel>
    );
  }

  const projectFileExists = existsSync(scopedOrchestrationPath("project", cwd));
  return (
    <FooterPanel
      command="/orchestration"
      title="Orchestration"
      subtitle="Choose how agents pick their models."
      footerHints={rootFooterHints(mode)}
      onCancel={close}
    >
      <Box flexDirection="column">
        <FooterPanelRow
          label="Mode"
          value={MODE_VALUE[mode]}
          description={MODE_DESCRIPTION[mode]}
          selected={sel === 0}
        />
        {mode !== "feudalism" ? (
          <Box paddingLeft={2} marginTop={1} flexDirection="column">
            {IDLE_NOTE_LINES.map((line) => (
              <Text key={line} color={Color.muted}>
                {line}
              </Text>
            ))}
          </Box>
        ) : (
          <>
            <FooterPanelRow
              label="Save edits to"
              value={scope === "project" ? "This project" : "All projects"}
              description={scopeDescription(scope, projectFileExists)}
              selected={sel === 1}
            />
            <Box paddingLeft={2} marginTop={1}>
              <Text color={Color.muted}>{TIERS_HEADING}</Text>
            </Box>
            {TIER_NAMES.map((tier, i) => (
              <FooterPanelRow
                key={tier}
                label={TIER_LABEL[tier]}
                value={rosters[tier].entries[0]?.model ?? "Off"}
                valueColor={rosters[tier].entries.length === 0 ? Color.muted : undefined}
                description={tierRowDescription(rosters[tier])}
                selected={sel === 2 + i}
              />
            ))}
            <Box marginTop={1}>
              <FooterPanelRow
                label="Edit as JSON"
                description="opens the file in your editor"
                selected={sel === 2 + TIER_NAMES.length}
              />
            </Box>
          </>
        )}
      </Box>
    </FooterPanel>
  );
}

function DraftRow({ draft }: { draft: string }): React.JSX.Element {
  return (
    <Box width="100%">
      <Text color={PanelColor.chevron}>{Glyph.chevron}</Text>
      <Box width={34} flexShrink={0}>
        <Text color={PanelColor.selected} bold>
          {ADD_ROW_LABEL}
        </Text>
      </Box>
      <Text color={Color.text}>{draft}</Text>
      <Text inverse> </Text>
    </Box>
  );
}

function rootFooterHints(mode: OrchestrationMode): [string, string][] {
  if (mode !== "feudalism") {
    return [
      ["Enter", "change mode"],
      ["Esc", "close"],
    ];
  }
  return [
    ["↑↓", "move"],
    ["Enter", "change / open"],
    ["s", "save location"],
    ["Esc", "close"],
  ];
}

function tierFooterHints(
  drafting: boolean,
  onAddRow: boolean,
  overridden: boolean,
): [string, string][] {
  if (drafting) {
    return [
      ["Enter", "save"],
      ["Esc", "cancel"],
    ];
  }
  const hints: [string, string][] = onAddRow
    ? [
        ["↑↓", "move"],
        ["Enter", "add a model"],
      ]
    : [
        ["↑↓", "move"],
        ["+/-", "reorder"],
        ["x", "remove"],
      ];
  if (overridden) hints.push(["r", "reset to built-in"]);
  hints.push(["Esc", "back"]);
  return hints;
}

function scopeDescription(scope: RosterScope, projectFileExists: boolean): string {
  if (scope === "project") return ".otherside/orchestration.json";
  return projectFileExists
    ? "~/.otherside/orchestration.json · a project file overrides this"
    : "~/.otherside/orchestration.json";
}

function tierRowDescription(roster: TierRoster): string {
  if (roster.entries.length === 0) return "edited · no models in this tier";
  const backups = roster.entries.slice(1);
  const parts = [
    backups.length > 0 ? `then ${backups.map((entry) => entry.model).join(", ")}` : "no backups",
  ];
  if (roster.overridden) parts.push("edited");
  return parts.join(" · ");
}

function entryLabel(index: number): string {
  return index === 0 ? "First choice" : `Backup ${index}`;
}

function titleCase(tier: TierName): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

function displayPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function launchFailureMessage(launch: EditorLaunch | null): string {
  if (launch === null || launch.ok) return "";
  if (launch.reason === "none-found") {
    return "No editor found. Set $VISUAL or $EDITOR, or install a GUI editor like VS Code or Cursor.";
  }
  if (launch.reason === "terminal-editor") {
    return `${launch.editor} is a terminal editor — open the file from your shell instead.`;
  }
  return launch.editor !== undefined
    ? `Couldn't launch ${launch.editor}.`
    : "Couldn't launch your editor.";
}
