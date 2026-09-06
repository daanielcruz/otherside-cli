import { displayMcpServerName } from "@/kernel/mcp/index.ts";
import type { TerminalColor } from "@/terminal-runtime/text/style-model.js";
import { type ListPanelSpec, renderListPanel } from "@/ui/chrome/string-view-panel.ts";
import {
  formatCount,
  groupServerRows,
  listRowStatus,
  type McpServerRow,
} from "@/ui/panels/mcp/data.ts";
import { Color } from "@/ui/theme/theme.ts";

function statusToneColor(tone: ReturnType<typeof listRowStatus>["tone"]): TerminalColor {
  if (tone === "success") return Color.success;
  if (tone === "warning") return Color.warning;
  if (tone === "error") return Color.error;
  return Color.muted;
}

export function renderMcpList(input: {
  rows: McpServerRow[];
  loading: boolean;
  error: string | null;
  serverIndex: number;
  terminalRows: number;
  width: number;
}): string[] {
  const { rows, loading, error, serverIndex, terminalRows, width } = input;
  const groups = groupServerRows(rows, process.cwd());
  const ordered = groups.flatMap((group) => group.rows);
  const groupByName = new Map<string, string>();
  for (const group of groups) {
    for (const row of group.rows) groupByName.set(row.name, group.label);
  }

  let emptyLabel = "No MCP servers configured";
  if (loading) emptyLabel = "Checking MCP server health…";
  else if (error) emptyLabel = error;

  const items = ordered.map((row, index) => {
    const status = listRowStatus(row);
    const group = groupByName.get(row.name);
    return {
      id: row.name,
      label: displayMcpServerName(row.name),
      value: `${status.icon} ${status.text}`,
      valueColor: statusToneColor(status.tone),
      muted: !row.enabled || status.tone === "inactive",
      ...(index === serverIndex && group ? { description: group } : {}),
    };
  });

  const failed = !loading && rows.some((row) => row.inspection.status === "failed");
  const countLabel = loading ? "loading…" : error ? "error" : formatCount(rows.length, "server");
  const subtitle = failed ? `${countLabel} · run otherside --debug for error logs` : countLabel;

  const spec: ListPanelSpec = {
    command: "/mcp",
    title: "Manage MCP servers",
    subtitle,
    items,
    cursor: serverIndex,
    maxRows: terminalRows,
    emptyLabel,
    footerHints:
      loading || ordered.length === 0
        ? [["Esc", "close"]]
        : [
            ["↑/↓", "navigate"],
            ["Enter", "detail"],
            ["Esc", "close"],
          ],
  };
  return renderListPanel(spec, width);
}
