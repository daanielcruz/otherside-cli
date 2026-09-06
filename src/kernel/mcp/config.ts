import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { projectSettingsPath, readProjectSettings } from "@/kernel/config/scope.ts";
import type { McpJsonConfig, McpServerConfig } from "@/kernel/mcp/index.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";
import { loadProjectMcpServerStatuses } from "./project-trust.ts";
import { expandServerEnvironment, parseServer } from "./server-config.ts";
import { isMcpServerPermittedByPolicy } from "./server-policy.ts";
import { loadDisabledMcpServers } from "./server-settings.ts";

export {
  approveProjectMcpServer,
  isProjectMcpTrusted,
  loadProjectMcpServerStatuses,
  type ProjectMcpServerStatus,
  readProjectMcpServerStatus,
  rejectProjectMcpServer,
  setProjectMcpTrusted,
} from "./project-trust.ts";
export { parseMcpServerSpec, parseServer } from "./server-config.ts";
export { isMcpServerDenied, isMcpServerPermittedByPolicy } from "./server-policy.ts";
export {
  disableMcpServer,
  enableMcpServer,
  loadDisabledMcpServers,
} from "./server-settings.ts";
// Precedence (lowest to highest): plugin < user < approved project < local.
// "local" is the current project's untracked settings.local.json — personal
// to this checkout, never shared via .mcp.json, and not subject to project
// trust prompting (see loadEnabledMcpConfig). "dynamic" servers come from
// plugins and the --mcp-config flag: configured in memory, no file on disk.
export type McpScope = "user" | "project" | "local" | "dynamic";

export interface McpConfigSource {
  scope: McpScope;
  path?: string;
}

let pluginMcpServersProvider: () => Record<string, McpServerConfig> = () => ({});

export function setPluginMcpServersProvider(fn: () => Record<string, McpServerConfig>): void {
  pluginMcpServersProvider = fn;
}

export interface LoadedMcpConfig {
  config: McpJsonConfig;
  sources: Record<string, McpConfigSource>;
}

function userMcpJsonChain(): string[] {
  const root = configRoot();
  return [join(root, "mcp.json"), join(root, ".mcp.json")];
}

function projectMcpJsonChain(cwd: string): string[] {
  const out: string[] = [];
  let dir = isAbsolute(cwd) ? cwd : resolve(cwd);
  const seen = new Set<string>();
  while (!seen.has(dir)) {
    seen.add(dir);
    const candidate = join(dir, ".mcp.json");
    if (existsSync(candidate)) out.unshift(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

function parseConfig(text: string): McpJsonConfig {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const serversRaw = raw.mcpServers;
  const out: Record<string, McpServerConfig> = {};
  if (serversRaw && typeof serversRaw === "object" && !Array.isArray(serversRaw)) {
    for (const [name, value] of Object.entries(serversRaw as Record<string, unknown>)) {
      const parsed = parseServer(name, value);
      if (parsed) out[name] = parsed;
    }
  }
  return { mcpServers: out };
}

function loadOne(path: string, scope: McpScope): LoadedMcpConfig | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let cfg: McpJsonConfig;
  try {
    cfg = parseConfig(text);
  } catch {
    return null;
  }
  const sources: Record<string, McpConfigSource> = {};
  for (const name of Object.keys(cfg.mcpServers)) {
    sources[name] = { scope, path };
  }
  return { config: cfg, sources };
}

function loadLocalMcpConfig(cwd: string): LoadedMcpConfig | null {
  const raw = readProjectSettings(cwd, "local").mcpServers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const path = projectSettingsPath(cwd, "local");
  const servers: Record<string, McpServerConfig> = {};
  const sources: Record<string, McpConfigSource> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = parseServer(name, value);
    if (!parsed) continue;
    servers[name] = parsed;
    sources[name] = { scope: "local", path };
  }
  if (Object.keys(servers).length === 0) return null;
  return { config: { mcpServers: servers }, sources };
}

export async function loadMcpConfigChain(cwd: string): Promise<LoadedMcpConfig[]> {
  const chain: LoadedMcpConfig[] = [];
  for (const path of userMcpJsonChain()) {
    const loaded = loadOne(path, "user");
    if (loaded) chain.push(loaded);
  }
  for (const path of projectMcpJsonChain(cwd)) {
    const loaded = loadOne(path, "project");
    if (loaded) chain.push(loaded);
  }
  // Local scope is loaded last so it wins ties in mergeChildWins, enforcing
  // the manual-scope precedence: user < approved project < local.
  const local = loadLocalMcpConfig(cwd);
  if (local) chain.push(local);
  return chain;
}

export function mergeChildWins(chain: LoadedMcpConfig[]): LoadedMcpConfig {
  const merged: McpJsonConfig = { mcpServers: {} };
  const sources: Record<string, McpConfigSource> = {};
  for (const entry of chain) {
    for (const [name, server] of Object.entries(entry.config.mcpServers)) {
      merged.mcpServers[name] = server;
      const src = entry.sources[name];
      if (src) sources[name] = src;
    }
  }
  return { config: merged, sources };
}

export async function loadEffectiveMcpConfigWithSources(cwd: string): Promise<LoadedMcpConfig> {
  const chain = await loadMcpConfigChain(cwd);
  const merged = mergeChildWins(chain);
  for (const [name, server] of Object.entries(pluginMcpServersProvider())) {
    if (!merged.config.mcpServers[name]) {
      merged.config.mcpServers[name] = server;
      merged.sources[name] = { scope: "dynamic" };
    }
  }
  // --mcp-config flag servers override file/plugin entries, matching the
  // connection path (see the manager's flag fold-in).
  for (const [name, server] of Object.entries(loadFlagMcpServers(cwd))) {
    merged.config.mcpServers[name] = server;
    merged.sources[name] = { scope: "dynamic" };
  }
  return merged;
}

export function serverConfigLocation(cwd: string, source?: McpConfigSource): string {
  if (!source) return "Dynamically configured";
  switch (source.scope) {
    case "user":
      return source.path ?? userMcpJsonChain().at(-1)!;
    case "project":
      return source.path ?? join(cwd, ".mcp.json");
    case "local":
      return `${userMcpJsonChain().at(-1)!} [project: ${cwd}]`;
    case "dynamic":
      return "Dynamically configured";
  }
}

function parseFlagMcpConfigEntry(raw: string, cwd: string): Record<string, McpServerConfig> {
  const trimmed = raw.trim();
  const text = trimmed.startsWith("{") ? raw : readFileSync(resolve(cwd, trimmed), "utf8");
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    throw new Error("expected object with mcpServers object");
  }
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(parsed.mcpServers)) {
    const config = parseServer(name, server);
    if (config === null) throw new Error(`invalid server "${name}"`);
    servers[name] = config;
  }
  return servers;
}

// Servers supplied inline or by file via the --mcp-config flag, surfaced by the
// arg parser as OTHERSIDE_CLI_MCP_CONFIGS. They carry local-scope semantics —
// trust-exempt — and are honored on both the print and interactive paths. A
// malformed entry throws so callers can surface or isolate the failure.
export function loadFlagMcpServers(cwd: string): Record<string, McpServerConfig> {
  const raw = process.env.OTHERSIDE_CLI_MCP_CONFIGS;
  if (!raw) return {};
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!Array.isArray(entries)) return {};
  const servers: Record<string, McpServerConfig> = {};
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    Object.assign(servers, parseFlagMcpConfigEntry(entry, cwd));
  }
  return servers;
}

export async function loadEnabledMcpConfig(cwd: string): Promise<McpJsonConfig> {
  const loaded = await loadEffectiveMcpConfigWithSources(cwd);
  const disabled = await loadDisabledMcpServers(cwd);
  const projectNames = Object.keys(loaded.config.mcpServers).filter(
    (name) => loaded.sources[name]?.scope === "project",
  );
  const projectStatuses = await loadProjectMcpServerStatuses(cwd, projectNames);
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(loaded.config.mcpServers)) {
    if (disabled.has(name)) continue;
    // Only project-scope (.mcp.json) servers require trust approval. Local-scope
    // servers live in the untracked settings.local.json the user already
    // controls directly, so they skip project trust filtering entirely.
    if (loaded.sources[name]?.scope === "project" && projectStatuses.get(name) !== "approved") {
      continue;
    }
    // Enterprise policy gate: applies to every scope (user/project/local/
    // plugin) so a repo's own .mcp.json can never grant itself an exemption.
    // Checked last so both disabled-flag and project-trust rejections above
    // still short-circuit first for their own (cheaper, non-policy) reasons.
    if (!isMcpServerPermittedByPolicy(cwd, name, server)) continue;
    mcpServers[name] = expandServerEnvironment(server);
  }
  return { mcpServers };
}

export async function hasProjectMcpServers(cwd: string): Promise<boolean> {
  const loaded = await loadEffectiveMcpConfigWithSources(cwd);
  return Object.values(loaded.sources).some((source) => source.scope === "project");
}
