import { homedir } from "node:os";
import type { TierName } from "@/engine/model/tier/names.ts";
import type { RosterEntry, RosterScope } from "@/engine/model/tier/roster-overlay.ts";
import type { EditorLaunch } from "@/kernel/std/proc/editor-launch.ts";
import type { OrchestrationMode } from "@/kernel/std/types/orchestration-mode.ts";

/** What a tier holds, as the panel and its copy both read it. */
export interface TierRoster {
  entries: RosterEntry[];
  overridden: boolean;
}

import { labelColumnWidth } from "@/ui/chrome/string-view-panel.ts";

export const MODE_VALUE: Record<OrchestrationMode, string> = {
  disabled: "Disabled",
  default: "Default",
  feudalism: "Feudalism",
};

export const MODE_DESCRIPTION: Record<OrchestrationMode, string> = {
  disabled: "agents use your current model",
  default: "agents pick from the model catalog",
  feudalism: "four tiers, each with its own lineup",
};

export const TIER_LABEL: Record<TierName, string> = {
  emperor: "Emperor — deep reasoning",
  shogun: "Shogun — complex work",
  daimyo: "Daimyo — everyday tasks",
  samurai: "Samurai — bulk work",
};

export const TIER_ROLE_SENTENCE: Record<TierName, string> = {
  emperor: "Deep reasoning for the hardest problems.",
  shogun: "Complex work that needs judgment.",
  daimyo: "Fast, capable everyday work.",
  samurai: "Simple bulk work, fanned out in parallel.",
};

export const LINEUP_SENTENCE =
  "The first model that works is used; the rest are backups, in order.";
export const TIERS_HEADING = "Tiers — press Enter to edit a lineup";
export const ADD_ROW_LABEL = "+ Add a model";
export const ADD_ROW_DESCRIPTION = "type the provider, then the model";
export const DRAFT_GUIDE =
  'For example "anthropic claude-opus-4-6" — provider first, then a space, then the model.';
export const DRAFT_INVALID =
  "That doesn't look right — type the provider, a space, then the model.";
export const EMPTY_TIER_NOTE = "This tier is turned off — no models in its lineup.";
export const IDLE_NOTE_LINES = [
  "Nothing to set up in this mode.",
  "Switch the mode to Feudalism to choose which models each tier of agents uses.",
] as const;
export const JSON_EXAMPLE = `{
  "tiers": {
    "emperor": [
      { "provider": "anthropic", "model": "claude-opus-4-6" }
    ]
  }
}`;
export const JSON_HELP_LINES = [
  "The first model listed is the first choice; the rest are backups, in order.",
  "Leave a tier out to keep its built-in lineup. An empty list turns the tier off.",
  "Changes are picked up automatically the next time agents run.",
] as const;

export function rootFooterHints(mode: OrchestrationMode): [string, string][] {
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

export function tierFooterHints(
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

export function scopeDescription(scope: RosterScope, projectFileExists: boolean): string {
  if (scope === "project") return ".otherside/orchestration.json";
  return projectFileExists
    ? "~/.otherside/orchestration.json · a project file overrides this"
    : "~/.otherside/orchestration.json";
}

export function tierRowDescription(roster: TierRoster): string {
  if (roster.entries.length === 0) return "edited · no models in this tier";
  const backups = roster.entries.slice(1);
  const parts = [
    backups.length > 0 ? `then ${backups.map((entry) => entry.model).join(", ")}` : "no backups",
  ];
  if (roster.overridden) parts.push("edited");
  return parts.join(" · ");
}

/** The tier list's column: its own row labels, plus the add row that follows them. */
export function tierColumnWidth(entryCount: number): number {
  const labels = Array.from({ length: entryCount }, (_, index) => entryLabel(index));
  return labelColumnWidth([...labels, ADD_ROW_LABEL]);
}

export function entryLabel(index: number): string {
  return index === 0 ? "First choice" : `Backup ${index}`;
}

export function titleCase(tier: TierName): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

export function displayPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function launchFailureMessage(launch: EditorLaunch | null): string {
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
