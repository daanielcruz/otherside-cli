import type { PluginInstallScope } from "@/engine/plugins/installations.ts";
import { sharedGraphemeSegmenter } from "@/kernel/std/intl.ts";
import { wrapProse } from "@/terminal-runtime/text/ansi-wrap.js";
import { stringWidth } from "@/terminal-runtime/text/cell-width.js";
import { renderTextWithStyles } from "@/terminal-runtime/text/color-codes.js";
import { renderPanelRowLine } from "@/ui/chrome/string-view-panel.ts";
import { MENU_ROW_WIDTH, type PanelDetailView } from "@/ui/panels/plugins/chrome.ts";
import type { DiscoverItem } from "@/ui/panels/plugins/types.ts";
import { Color } from "@/ui/theme/theme.ts";

/** Scopes an install can be made in, in the order the detail view offers them. */
export const INSTALL_SCOPES: readonly PluginInstallScope[] = ["user", "project", "local"];

const DISCOVER_DESCRIPTION_WIDTH = 60;
const ENTRY_DATE_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const TRUST_WARNING =
  "⚠ Make sure you trust a plugin before installing, updating, or using it. otherside does not control what MCP servers, files, or other software are included in plugins and cannot verify that they will work as intended or that they won't change. See each plugin's homepage for more information.";

export function formatEntryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${ENTRY_DATE_MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

export function formatInstallCount(count: number): string {
  if (count >= 1_000_000) return `${Math.round(count / 100_000) / 10}M`;
  if (count >= 1_000) return `${Math.round(count / 100) / 10}K`;
  return String(count);
}

/** Clip a catalogue description to one row, counting grapheme width rather than code units. */
export function truncateDiscoverDescription(
  description: string,
  width: number = DISCOVER_DESCRIPTION_WIDTH,
): string {
  if (stringWidth(description) <= width) return description;
  const ellipsis = "…";
  const contentWidth = Math.max(0, width - stringWidth(ellipsis));
  let used = 0;
  let truncated = "";
  for (const { segment } of sharedGraphemeSegmenter().segment(description)) {
    const segmentWidth = stringWidth(segment);
    if (used + segmentWidth > contentWidth) break;
    truncated += segment;
    used += segmentWidth;
  }
  return `${truncated}${ellipsis}`;
}

/** Install-scope labels, worded as what the choice means for who else gets the plugin. */
function scopeLabel(scope: PluginInstallScope): string {
  if (scope === "user") return "Install for you (user scope)";
  if (scope === "project")
    return "Install for all collaborators on this repository (project scope)";
  return "Install for you, in this repo only (local scope)";
}

/**
 * One catalogue entry before it is installed. Components are not listed because nothing
 * has been fetched yet — they are only known once the plugin is on disk.
 */
export function discoverDetailView(input: {
  item: DiscoverItem;
  contentWidth: number;
  optionIndex: number;
}): PanelDetailView {
  const { item, contentWidth, optionIndex } = input;
  const body: string[] = [];
  body.push(renderTextWithStyles(item.entry.name, { color: Color.textStrong, bold: true }));
  body.push(renderTextWithStyles(`from ${item.marketplace}`, { color: Color.muted }));
  if (item.entry.lastUpdated) {
    body.push(
      renderTextWithStyles(`Last updated: ${formatEntryDate(item.entry.lastUpdated)}`, {
        color: Color.muted,
      }),
    );
  }
  if (item.entry.description) {
    body.push("");
    for (const line of wrapProse(item.entry.description, contentWidth)) {
      body.push(renderTextWithStyles(line, { color: Color.text }));
    }
  }
  body.push("");
  body.push(renderTextWithStyles("Will install:", { color: Color.text }));
  body.push(
    renderTextWithStyles("· Components will be discovered at installation", {
      color: Color.muted,
    }),
  );
  body.push("");
  for (const line of wrapProse(TRUST_WARNING, contentWidth)) {
    body.push(renderTextWithStyles(line, { color: Color.warning }));
  }
  body.push("");

  const optionRows: { key: string; label: string }[] = INSTALL_SCOPES.map((candidate) => ({
    key: candidate,
    label: scopeLabel(candidate),
  }));
  if (item.entry.homepage) optionRows.push({ key: "homepage", label: "Open homepage" });
  for (let index = 0; index < optionRows.length; index++) {
    body.push(
      renderPanelRowLine(
        { label: optionRows[index]!.label, selected: index === optionIndex },
        contentWidth,
        MENU_ROW_WIDTH,
      ),
    );
  }
  body.push(renderTextWithStyles("  Back to plugin list", { color: Color.muted }));

  return {
    body,
    subtitle: "Plugin details",
    footerHints: [
      ["Enter", "to select"],
      ["Esc", "to go back"],
    ],
  };
}
