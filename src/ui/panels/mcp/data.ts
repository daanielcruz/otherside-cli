import { type Color as InkColor } from "@/ink";
import {
  loadDisabledMcpServers,
  loadEffectiveMcpConfigWithSources,
  loadProjectMcpServerStatuses,
  type McpConfigSource,
  type ProjectMcpServerStatus,
} from "@/kernel/mcp/config.ts";
import {
  inspectServer,
  MCP_DISABLED_INSPECTION,
  type McpServerConfig,
  type McpServerInspection,
} from "@/kernel/mcp/index.ts";
import { Color, Glyph } from "@/ui/theme/theme.ts";

export interface McpServerRow {
  name: string;
  config: McpServerConfig;
  source?: McpConfigSource;
  projectStatus?: ProjectMcpServerStatus;
  enabled: boolean;
  inspection: McpServerInspection;
}
export interface McpGroup {
  key: string;
  label: string;
  path?: string;
  rows: McpServerRow[];
}

export interface McpMenuOption {
  id: "tools" | "reconnect" | "toggle" | "authenticate" | "trust" | "trustAll" | "reject";
  label: string;
}

export const TOOL_PAGE_SIZE = 5;

export const UNTRUSTED_INSPECTION: McpServerInspection = {
  status: "untrusted",
  statusText: "⚠ untrusted",
  tools: [],
  error: null,
};

export async function resolveInspection(
  name: string,
  config: McpServerConfig,
  enabled: boolean,
  blockedByTrust: boolean,
): Promise<McpServerInspection> {
  if (blockedByTrust) return UNTRUSTED_INSPECTION;
  if (!enabled) return MCP_DISABLED_INSPECTION;
  return inspectServer(name, config);
}

export async function loadMcpRows(): Promise<McpServerRow[]> {
  const cwd = process.cwd();
  const loaded = await loadEffectiveMcpConfigWithSources(cwd);
  const disabled = await loadDisabledMcpServers(cwd);
  const entries = Object.entries(loaded.config.mcpServers).sort(([a], [b]) => a.localeCompare(b));
  const projectNames = entries
    .filter(([name]) => loaded.sources[name]?.scope === "project")
    .map(([name]) => name);
  const projectStatuses = await loadProjectMcpServerStatuses(cwd, projectNames);
  return Promise.all(
    entries.map(async ([name, config]) => {
      const enabled = !disabled.has(name);
      const source = loaded.sources[name];
      const projectStatus = projectStatuses.get(name);
      const blockedByTrust = source?.scope === "project" && projectStatus !== "approved";
      return {
        name,
        config,
        ...(source ? { source } : {}),
        ...(projectStatus ? { projectStatus } : {}),
        enabled,
        inspection: await resolveInspection(name, config, enabled, blockedByTrust),
      };
    }),
  );
}

export function groupServerRows(rows: McpServerRow[]): McpGroup[] {
  const groups = new Map<string, McpGroup>();
  for (const row of rows) {
    const scope = row.source?.scope ?? "project";
    const path = row.source?.path;
    const key = `${scope}:${path ?? ""}`;
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(row);
    } else {
      groups.set(key, {
        key,
        label: scope === "user" ? "User MCPs" : "Project MCPs",
        ...(path ? { path } : {}),
        rows: [row],
      });
    }
  }
  const order = new Map([
    ["project", 0],
    ["user", 1],
  ]);
  return [...groups.values()]
    .sort((a, b) => {
      const aScope = a.key.split(":")[0] ?? "";
      const bScope = b.key.split(":")[0] ?? "";
      return (order.get(aScope) ?? 10) - (order.get(bScope) ?? 10) || a.key.localeCompare(b.key);
    })
    .map((group) => ({
      ...group,
      rows: [...group.rows].sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

export function serverMenuOptions(server: McpServerRow | undefined): McpMenuOption[] {
  if (!server) return [];
  if (server.inspection.status === "untrusted") {
    return [
      { id: "trust", label: "Use this MCP server" },
      { id: "trustAll", label: "Use this and all future MCP servers in this project" },
      { id: "reject", label: "Continue without using this MCP server" },
    ];
  }
  const options: McpMenuOption[] = [];
  if (server.enabled && server.inspection.tools.length > 0) {
    options.push({ id: "tools", label: "View tools" });
  }
  if (server.enabled && server.inspection.status === "needs-auth" && isRemote(server.config)) {
    options.push({ id: "authenticate", label: "Authenticate" });
  }
  if (server.enabled) options.push({ id: "reconnect", label: "Reconnect" });
  options.push({ id: "toggle", label: server.enabled ? "Disable" : "Enable" });
  return options;
}

export function isRemote(
  config: McpServerConfig,
): config is Extract<McpServerConfig, { url: string }> {
  return config.type === "http" || config.type === "sse";
}

export function capabilities(server: McpServerRow): string {
  const out: string[] = [];
  if (server.inspection.tools.length > 0) out.push("tools");
  return out.length > 0 ? out.join(" · ") : "none";
}

export function statusColor(status: McpServerInspection["status"]): InkColor {
  if (status === "connected") return Color.success;
  if (status === "failed") return Color.error;
  if (status === "needs-auth") return Color.warning;
  if (status === "untrusted") return Color.warning;
  return Color.muted;
}

export function toolMarker(index: number, selected: number, start: number, total: number): string {
  if (index === selected) return Glyph.chevron.trimEnd();
  if (index === start && start > 0) return Glyph.arrowUp;
  if (index === start + TOOL_PAGE_SIZE - 1 && index + 1 < total) return Glyph.arrowDown;
  return " ";
}

export function toolWindowStart(selected: number, total: number): number {
  if (total <= TOOL_PAGE_SIZE) return 0;
  return Math.min(Math.max(0, selected - TOOL_PAGE_SIZE + 1), total - TOOL_PAGE_SIZE);
}

export function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}
