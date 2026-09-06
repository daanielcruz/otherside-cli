import { join } from "node:path";
import {
  loadDisabledMcpServers,
  loadEffectiveMcpConfigWithSources,
  loadProjectMcpServerStatuses,
  type McpConfigSource,
  type McpScope,
  type ProjectMcpServerStatus,
  serverConfigLocation,
} from "@/kernel/mcp/config.ts";
import {
  inspectServer,
  MCP_DISABLED_INSPECTION,
  MCP_PENDING_INSPECTION,
  type McpServerConfig,
  type McpServerInspection,
} from "@/kernel/mcp/index.ts";
import { isExpired, loadOAuthToken } from "@/kernel/mcp/oauth/token-store.ts";

export function hasOAuthToken(serverName: string): boolean {
  const token = loadOAuthToken(serverName);
  return token !== null && !isExpired(token);
}

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

export async function loadMcpRows(
  onInspection?: (name: string, inspection: McpServerInspection) => void,
): Promise<McpServerRow[]> {
  const cwd = process.cwd();
  const loaded = await loadEffectiveMcpConfigWithSources(cwd);
  const disabled = await loadDisabledMcpServers(cwd);
  const entries = Object.entries(loaded.config.mcpServers).sort(([a], [b]) => a.localeCompare(b));
  const projectNames = entries
    .filter(([name]) => loaded.sources[name]?.scope === "project")
    .map(([name]) => name);
  const projectStatuses = await loadProjectMcpServerStatuses(cwd, projectNames);
  // Untrusted/disabled statuses resolve synchronously; enabled servers paint
  // immediately as pending and stream their real inspection via onInspection.
  const rows = entries.map(([name, config]): McpServerRow => {
    const enabled = !disabled.has(name);
    const source = loaded.sources[name];
    const projectStatus = projectStatuses.get(name);
    const blockedByTrust = source?.scope === "project" && projectStatus !== "approved";
    const inspection = blockedByTrust
      ? UNTRUSTED_INSPECTION
      : enabled
        ? MCP_PENDING_INSPECTION
        : MCP_DISABLED_INSPECTION;
    return {
      name,
      config,
      ...(source ? { source } : {}),
      ...(projectStatus ? { projectStatus } : {}),
      enabled,
      inspection,
    };
  });
  void Promise.all(
    rows.map(async (row) => {
      if (row.inspection.status !== "pending") return;
      const inspection = await inspectServer(row.name, row.config);
      onInspection?.(row.name, inspection);
    }),
  );
  return rows;
}

export function groupServerRows(rows: McpServerRow[], cwd: string): McpGroup[] {
  const groups = new Map<string, McpGroup>();
  for (const row of rows) {
    const scope = row.source?.scope ?? "dynamic";
    const key = scope;
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(row);
    } else {
      groups.set(key, { key, ...groupHeading(scope, cwd), rows: [row] });
    }
  }
  const order = new Map([
    ["project", 0],
    ["local", 1],
    ["user", 2],
    ["dynamic", 5],
  ]);
  return [...groups.values()]
    .sort(
      (a, b) => (order.get(a.key) ?? 10) - (order.get(b.key) ?? 10) || a.key.localeCompare(b.key),
    )
    .map((group) => ({
      ...group,
      rows: [...group.rows].sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

function groupHeading(scope: McpScope, cwd: string): { label: string; path?: string } {
  switch (scope) {
    case "project":
      return { label: "Project MCPs", path: join(cwd, ".mcp.json") };
    case "local":
      return {
        label: "Local MCPs",
        path: serverConfigLocation(cwd, { scope: "local" }),
      };
    case "user":
      return { label: "User MCPs", path: serverConfigLocation(cwd, { scope: "user" }) };
    case "dynamic":
      return { label: "Built-in MCPs", path: "always available" };
  }
}

export interface ListRowStatus {
  icon: string;
  tone: "success" | "warning" | "error" | "inactive";
  text: string;
}

export function listRowStatus(row: McpServerRow): ListRowStatus {
  const inspection = row.inspection;
  if (inspection.status === "untrusted") return { icon: "⚠", tone: "warning", text: "untrusted" };
  if (!row.enabled || inspection.status === "disabled") {
    return { icon: "◯", tone: "inactive", text: "disabled" };
  }
  if (inspection.status === "needs-auth") {
    return { icon: "△", tone: "warning", text: "needs authentication" };
  }
  if (inspection.status === "pending") {
    return { icon: "◯", tone: "inactive", text: "connecting…" };
  }
  if (inspection.status === "failed") return { icon: "✘", tone: "error", text: "failed" };
  if (inspection.toolsError) {
    return { icon: "△", tone: "warning", text: "connected · tools fetch failed" };
  }
  if (inspection.tools.length === 0) {
    return { icon: "△", tone: "warning", text: "connected · no tools" };
  }
  return {
    icon: "✔",
    tone: "success",
    text: `connected · ${formatCount(inspection.tools.length, "tool")}`,
  };
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
  if (
    server.enabled &&
    isRemote(server.config) &&
    (server.inspection.status === "needs-auth" ||
      (server.inspection.status === "failed" && !hasOAuthToken(server.name)))
  ) {
    options.push({ id: "authenticate", label: "Authenticate" });
  }
  if (server.enabled && server.inspection.status !== "needs-auth") {
    options.push({ id: "reconnect", label: "Reconnect" });
  }
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

export function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}
