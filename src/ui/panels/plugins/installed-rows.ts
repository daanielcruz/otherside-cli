import type { LoadedPlugin } from "@/engine/plugins/loader.ts";
import type { SkillState } from "@/kernel/config/config.ts";
import type { McpConnectionStatus } from "@/kernel/mcp/client/registry.ts";
import { pluralize } from "@/kernel/std/text/pluralize.ts";
import { cellClip } from "@/terminal-runtime/text/cell-clip.ts";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { renderPanelRowLine } from "@/ui/chrome/string-view-panel.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

// Unified installed-list model: plugins (with indented child MCP rows),
// standalone MCP servers, and standalone skills share one sectioned list.
export type InstalledItem =
  | {
      type: "plugin";
      id: string;
      plugin: LoadedPlugin;
      name: string;
      marketplace: string;
      scope: string;
      isEnabled: boolean;
      appliedEnabled: boolean;
      errorCount: number;
      unusedDays?: number;
      activity?: { skillCount: number; totalCount: number };
    }
  | {
      type: "failed-plugin";
      id: string;
      name: string;
      marketplace: string;
      scope: string;
      errorCount: number;
    }
  | {
      type: "mcp";
      id: string;
      name: string;
      scope: string;
      status: McpConnectionStatus | "disabled";
      indented: boolean;
      parentId?: string;
    }
  | {
      type: "skill";
      id: string;
      name: string;
      description: string;
      whenToUse: string;
      skillRoot?: string;
      scope: "skills";
      sourceLabel: string;
      state: SkillState;
      authorLocked: boolean;
      tokenEstimate: number;
      usage?: { count: number; daysSinceUse: number };
    };

export type InstalledSection = "attention" | "favorites" | "disused" | "main" | "disabled";

export type InstalledRow =
  | { kind: "spacer"; id: string }
  | { kind: "section"; id: string; section: "attention" | "favorites" | "disused" }
  | { kind: "scope"; id: string; scope: string }
  | { kind: "fold"; id: string; disabledCount: number }
  | { kind: "item"; id: string; section: InstalledSection; item: InstalledItem };

const SCOPE_RANK: Record<string, number> = {
  project: 0,
  local: 1,
  user: 2,
  enterprise: 3,
  managed: 4,
  dynamic: 5,
  builtin: 6,
  skills: 7,
};

export function installedScopeLabel(scope: string): string {
  switch (scope) {
    case "project":
      return "Project";
    case "local":
      return "Local";
    case "user":
      return "User";
    case "enterprise":
      return "Enterprise";
    case "managed":
      return "Managed";
    case "builtin":
    case "dynamic":
      return "Built-in";
    case "skills":
      return "Skills";
    default:
      return scope;
  }
}

function needsAttention(item: InstalledItem): boolean {
  switch (item.type) {
    case "plugin":
      return item.isEnabled && item.errorCount > 0;
    case "failed-plugin":
      return true;
    case "mcp":
      return item.status === "needs-auth" || item.status === "failed";
    case "skill":
      return false;
  }
}

function isDisabledItem(item: InstalledItem): boolean {
  return (
    (item.type === "plugin" && !item.isEnabled) ||
    (item.type === "mcp" && item.status === "disabled") ||
    (item.type === "skill" && item.state === "off")
  );
}

export interface BuildInstalledRowsOptions {
  favoriteIds: ReadonlySet<string>;
  disusedDays: ReadonlyMap<string, number>;
  showDisabled: boolean;
  keepInPlaceIds?: ReadonlySet<string>;
}

export function isSelectableInstalledRow(row: InstalledRow): boolean {
  return row.kind === "item" || row.kind === "fold";
}

/** Nearest selectable row index from `from` in `direction`, or -1 when none remains. */
export function findSelectableInstalledRow(
  rows: readonly InstalledRow[],
  from: number,
  direction: 1 | -1,
): number {
  const start = direction === -1 ? Math.min(from, rows.length - 1) : from;
  for (let index = start; index >= 0 && index < rows.length; index += direction) {
    if (isSelectableInstalledRow(rows[index]!)) return index;
  }
  return -1;
}

// An indented child MCP that lost its parent context (section change or a
// filtered-away plugin) renders as a top-level row.
function demoteIndentedMcp(item: Extract<InstalledItem, { type: "mcp" }>): typeof item {
  const { parentId: _dropped, ...rest } = item;
  return { ...rest, indented: false };
}

export function buildInstalledRows(
  items: readonly InstalledItem[],
  options: BuildInstalledRowsOptions,
): InstalledRow[] {
  const rows: InstalledRow[] = [];
  let previous: { section: InstalledSection; item: InstalledItem } | null = null;

  const pushRow = (section: InstalledSection, item: InstalledItem): void => {
    const sectionChanged = previous?.section !== section;
    if (sectionChanged) {
      if (rows.length > 0 && rows.at(-1)?.kind !== "fold") {
        rows.push({ kind: "spacer", id: `spacer:${rows.length}` });
      }
      if (section === "attention" || section === "favorites" || section === "disused") {
        rows.push({ kind: "section", id: `section:${section}`, section });
      }
    }
    if (
      (section === "main" || section === "disabled") &&
      (sectionChanged || previous?.item.scope !== item.scope)
    ) {
      if (!sectionChanged) rows.push({ kind: "spacer", id: `spacer:${rows.length}` });
      rows.push({ kind: "scope", id: `scope:${rows.length}`, scope: item.scope });
    }
    const staysIndented =
      !sectionChanged &&
      item.type === "mcp" &&
      item.parentId !== undefined &&
      ((previous?.item.type === "plugin" && previous.item.id === item.parentId) ||
        (previous?.item.type === "mcp" &&
          previous.item.indented &&
          previous.item.parentId === item.parentId));
    const finalItem =
      item.type === "mcp" && item.indented && !staysIndented ? demoteIndentedMcp(item) : item;
    rows.push({ kind: "item", id: `${section}:${item.id}`, section, item: finalItem });
    previous = { section, item: finalItem };
  };

  const claimed = new Set<string>();
  for (const item of items) {
    if (needsAttention(item)) {
      pushRow("attention", item);
      claimed.add(item.id);
    }
  }
  for (const item of items) {
    if (options.favoriteIds.has(item.id) && !claimed.has(item.id)) {
      pushRow("favorites", item);
      claimed.add(item.id);
    }
  }
  if (options.disusedDays.size > 0) {
    for (const item of items) {
      if (
        item.type === "plugin" &&
        item.isEnabled &&
        options.disusedDays.has(item.id) &&
        !claimed.has(item.id)
      ) {
        pushRow("disused", { ...item, unusedDays: options.disusedDays.get(item.id)! });
        claimed.add(item.id);
      }
    }
  }
  const isFolded = (item: InstalledItem): boolean =>
    isDisabledItem(item) && !options.keepInPlaceIds?.has(item.id);
  for (const item of items) {
    if (!isFolded(item) && !claimed.has(item.id)) pushRow("main", item);
  }
  const folded = items.filter(isFolded);
  if (folded.length > 0) {
    if (rows.length > 0) rows.push({ kind: "spacer", id: `spacer:${rows.length}` });
    rows.push({ kind: "fold", id: "section:disabled", disabledCount: folded.length });
    if (options.showDisabled) {
      for (const item of folded) pushRow("disabled", item);
    }
  }
  return rows;
}

// Groups items into scope buckets ordered by scope rank; within a bucket,
// plugin clusters (plugin plus its indented MCP children, sorted by plugin
// name) come first, then standalone MCPs and skills, each alphabetical.
export function sortInstalledItems(items: readonly InstalledItem[]): InstalledItem[] {
  const byScope = new Map<string, InstalledItem[]>();
  for (const item of items) {
    const bucket = byScope.get(item.scope) ?? [];
    bucket.push(item);
    byScope.set(item.scope, bucket);
  }
  const out: InstalledItem[] = [];
  const scopes = [...byScope.keys()].sort(
    (a, b) => (SCOPE_RANK[a] ?? 99) - (SCOPE_RANK[b] ?? 99) || a.localeCompare(b),
  );
  for (const scope of scopes) {
    const bucket = byScope.get(scope)!;
    const clusters: InstalledItem[][] = [];
    const mcps: InstalledItem[] = [];
    const skills: InstalledItem[] = [];
    let index = 0;
    while (index < bucket.length) {
      const item = bucket[index]!;
      if (item.type === "plugin" || item.type === "failed-plugin") {
        const cluster: InstalledItem[] = [item];
        index += 1;
        let next = bucket[index];
        while (next?.type === "mcp" && next.indented) {
          cluster.push(next);
          index += 1;
          next = bucket[index];
        }
        clusters.push(cluster);
      } else if (item.type === "mcp") {
        mcps.push(item);
        index += 1;
      } else {
        skills.push(item);
        index += 1;
      }
    }
    clusters.sort((a, b) => a[0]!.name.localeCompare(b[0]!.name));
    mcps.sort((a, b) => a.name.localeCompare(b.name));
    skills.sort((a, b) => a.name.localeCompare(b.name));
    for (const cluster of clusters) out.push(...cluster);
    out.push(...mcps, ...skills);
  }
  return out;
}

export function filterInstalledItems(
  items: readonly InstalledItem[],
  query: string,
): InstalledItem[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...items];
  return items.filter((item) => {
    if (item.name.toLowerCase().includes(q)) return true;
    if (
      item.type === "plugin" &&
      (item.plugin.manifest.description ?? "").toLowerCase().includes(q)
    )
      return true;
    if (item.type === "skill" && item.description.toLowerCase().includes(q)) return true;
    if (item.type === "mcp" && item.name.toLowerCase().includes(q)) return true;
    return false;
  });
}

interface InstalledStatus {
  glyph: string;
  label: string;
  color: typeof Color.muted;
}

interface InstalledLine {
  name: string;
  type: "Plugin" | "MCP" | "Skill";
  status: InstalledStatus;
  selected: boolean;
  contentWidth: number;
  source?: string;
  indented?: boolean;
  suffix?: string;
  warningSuffix?: string;
}

function flowingInstalledLine(input: InstalledLine): string {
  const idleStyle = input.selected ? {} : { color: Color.muted };
  const marker = input.selected
    ? renderTextWithStyles(Glyph.chevron, { color: Color.panelAccent })
    : "  ";
  const branch = input.indented ? renderTextWithStyles("└ ", idleStyle) : "";
  const name = renderTextWithStyles(input.name, {
    ...(input.selected ? { color: Color.panelAccent } : {}),
  });
  const chip =
    renderTextWithStyles(" ", idleStyle) +
    renderTextWithStyles(input.type, {
      backgroundColor: Color.inverseBg,
      color: Color.textStrong,
    });
  const source =
    input.source === undefined
      ? ""
      : renderTextWithStyles(` · ${input.source}`, { color: Color.muted });
  const status =
    renderTextWithStyles(" · ", idleStyle) +
    renderTextWithStyles(input.status.glyph, { color: input.status.color }) +
    renderTextWithStyles(` ${input.status.label}`, idleStyle);
  const suffix =
    input.suffix === undefined
      ? ""
      : renderTextWithStyles(` · ${input.suffix}`, { color: Color.muted });
  const warningSuffix =
    input.warningSuffix === undefined
      ? ""
      : renderTextWithStyles(` · ${input.warningSuffix}`, { color: Color.warning });
  return cellClip(
    marker + branch + name + chip + source + status + suffix + warningSuffix,
    input.contentWidth,
  );
}

function pluginStatus(item: Extract<InstalledItem, { type: "plugin" }>): InstalledStatus {
  if (item.isEnabled !== item.appliedEnabled) {
    return {
      glyph: "→",
      color: Color.panelAccent,
      label: item.isEnabled ? "will enable" : "will disable",
    };
  }
  if (item.errorCount > 0) {
    return {
      glyph: "✘",
      color: Color.error,
      label: `${item.errorCount} ${pluralize(item.errorCount, "error")}`,
    };
  }
  if (!item.isEnabled) return { glyph: Glyph.circleLarge, color: Color.muted, label: "disabled" };
  return { glyph: Glyph.check, color: Color.success, label: "enabled" };
}

function mcpStatus(item: Extract<InstalledItem, { type: "mcp" }>): InstalledStatus {
  if (item.status === "connected") {
    return { glyph: Glyph.check, color: Color.success, label: "connected" };
  }
  if (item.status === "disabled") {
    return { glyph: Glyph.circleLarge, color: Color.muted, label: "disabled" };
  }
  if (item.status === "pending") {
    return { glyph: Glyph.circleLarge, color: Color.muted, label: "connecting…" };
  }
  if (item.status === "needs-auth") {
    return { glyph: "△", color: Color.warning, label: "Enter to auth" };
  }
  return { glyph: "✘", color: Color.error, label: "failed" };
}

function skillStatus(item: Extract<InstalledItem, { type: "skill" }>): InstalledStatus {
  if (item.state === "on") return { glyph: Glyph.check, color: Color.success, label: "on" };
  if (item.state === "name-only") {
    return { glyph: Glyph.bulletFilled, color: Color.muted, label: "name-only" };
  }
  if (item.state === "user-invocable-only") {
    return { glyph: Glyph.circleLarge, color: Color.warning, label: "user-only" };
  }
  return { glyph: "✘", color: Color.error, label: "off" };
}

/**
 * One row of the installed list, drawn. Which glyph and status text a row carries is
 * decided here and nowhere else: a plugin reads pending / errored / disabled / enabled,
 * an MCP server reads its connection state, and a skill reads its state plus how much
 * context it costs and how recently it earned it.
 */
export function renderInstalledRowLines(
  row: InstalledRow,
  selected: boolean,
  showDisabled: boolean,
  contentWidth: number,
): string[] {
  if (row.kind === "spacer") return [""];
  if (row.kind === "section") {
    const label =
      row.section === "attention"
        ? "Needs attention"
        : row.section === "disused"
          ? "Not used recently"
          : "Favorites";
    return [
      "  " +
        renderTextWithStyles(label, {
          bold: true,
          color: row.section === "attention" ? Color.warning : Color.muted,
        }),
    ];
  }
  if (row.kind === "scope") {
    return [renderTextWithStyles(`    ${installedScopeLabel(row.scope)}`, { color: Color.muted })];
  }
  if (row.kind === "fold") {
    const arrow = showDisabled ? Glyph.arrowDown : "→";
    return [
      renderPanelRowLine(
        {
          label: `${arrow} Show disabled`,
          value: `(${row.disabledCount})`,
          selected,
        },
        contentWidth,
        24,
      ),
    ];
  }

  const item = row.item;
  if (item.type === "plugin") {
    const activity =
      item.activity !== undefined && item.activity.skillCount > 0
        ? `${item.activity.skillCount} ${pluralize(item.activity.skillCount, "skill")} · ${item.activity.totalCount} ${pluralize(item.activity.totalCount, "use")}`
        : undefined;
    const unused =
      item.unusedDays === undefined
        ? undefined
        : `not used in ${item.unusedDays} ${pluralize(item.unusedDays, "day")}`;
    const suffix = [activity, unused].filter((value) => value !== undefined).join(" · ");
    return [
      flowingInstalledLine({
        name: item.name,
        type: "Plugin",
        source: item.marketplace,
        status: pluginStatus(item),
        selected,
        contentWidth,
        ...(suffix === "" ? {} : { suffix }),
      }),
    ];
  }
  if (item.type === "failed-plugin") {
    return [
      flowingInstalledLine({
        name: item.name,
        type: "Plugin",
        source: item.marketplace,
        status: {
          glyph: "✘",
          color: Color.error,
          label: `failed to load · ${item.errorCount} ${pluralize(item.errorCount, "error")}`,
        },
        selected,
        contentWidth,
      }),
    ];
  }
  if (item.type === "mcp") {
    return [
      flowingInstalledLine({
        name: item.name,
        type: "MCP",
        status: mcpStatus(item),
        indented: item.indented,
        selected,
        contentWidth,
      }),
    ];
  }

  const usage = item.usage
    ? `${item.usage.count}× ${item.usage.daysSinceUse === 0 ? "today" : `${item.usage.daysSinceUse}d`}`
    : undefined;
  const suffix = `~${item.tokenEstimate} tok${usage === undefined ? "" : ` · ${usage}`}`;
  return [
    flowingInstalledLine({
      name: item.name,
      type: "Skill",
      source: item.sourceLabel,
      status: skillStatus(item),
      suffix,
      ...(usage === undefined ? { warningSuffix: "never used" } : {}),
      selected,
      contentWidth,
    }),
  ];
}
