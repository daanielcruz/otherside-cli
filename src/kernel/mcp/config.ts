import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadConfig } from "@/kernel/config/config.ts";
import { resolveConfig } from "@/kernel/config/resolver.ts";
import {
  projectSettingsPath,
  readProjectSettings,
  writeProjectSettings,
} from "@/kernel/config/scope.ts";
import type {
  McpJsonConfig,
  McpServerConfig,
  McpServerPolicyEntry,
  McpServerSpec,
} from "@/kernel/mcp/index.ts";
import { canonicalizeCwd, configRoot } from "@/kernel/std/fs/paths.ts";
import { getRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import { isYoloMode } from "@/kernel/std/proc/yolo-mode.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";

// Precedence (lowest to highest): plugin < user < approved project < local.
// "local" is the current project's untracked settings.local.json — personal
// to this checkout, never shared via .mcp.json, and not subject to project
// trust prompting (see loadEnabledMcpConfig).
export type McpScope = "user" | "project" | "local";

export interface McpConfigSource {
  scope: McpScope;
  path: string;
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

export function parseServer(name: string, raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== "object") {
    process.stderr.write(`mcp: server "${name}" entry is not an object — skipped\n`);
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const kind = typeof obj.type === "string" ? obj.type.toLowerCase() : null;
  const hasCommand = typeof obj.command === "string";
  const hasUrl = typeof obj.url === "string";
  if (kind === "stdio" || (kind === null && hasCommand)) {
    const command = typeof obj.command === "string" ? obj.command : "";
    if (!command) {
      process.stderr.write(`mcp: server "${name}" stdio entry missing command — skipped\n`);
      return null;
    }
    const args =
      Array.isArray(obj.args) && obj.args.every((v) => typeof v === "string")
        ? (obj.args as string[])
        : [];
    const envRaw = obj.env;
    let env: Record<string, string> | undefined;
    if (envRaw && typeof envRaw === "object" && !Array.isArray(envRaw)) {
      const acc: Record<string, string> = {};
      for (const [k, v] of Object.entries(envRaw as Record<string, unknown>)) {
        if (typeof v === "string") acc[k] = v;
      }
      env = acc;
    }
    const cwd = typeof obj.cwd === "string" && obj.cwd.length > 0 ? obj.cwd : undefined;
    return {
      type: "stdio",
      command,
      args,
      ...(env ? { env } : {}),
      ...(cwd ? { cwd } : {}),
    };
  }
  if (kind === "http" || kind === "sse" || (kind === null && hasUrl)) {
    const transport: "http" | "sse" = kind === "sse" ? "sse" : "http";
    const url = typeof obj.url === "string" ? obj.url : "";
    if (!url) {
      process.stderr.write(`mcp: server "${name}" ${transport} entry missing url — skipped\n`);
      return null;
    }
    const headers = parseHeaders(obj.headers);
    const oauth =
      obj.oauth && typeof obj.oauth === "object" && !Array.isArray(obj.oauth)
        ? (obj.oauth as Record<string, unknown>)
        : null;
    const oauthScopes = oauth && typeof oauth.scope === "string" ? oauth.scope : undefined;
    return {
      type: transport,
      url,
      ...(headers ? { headers } : {}),
      ...(oauthScopes ? { oauthScopes } : {}),
    };
  }
  process.stderr.write(`mcp: server "${name}" unsupported transport "${obj.type}" — skipped\n`);
  return null;
}

export function parseMcpServerSpec(raw: string): McpServerSpec | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith("{")) return trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const entry = Object.entries(parsed)[0];
  if (!entry || Object.keys(parsed).length !== 1) return null;
  const [name, rawConfig] = entry;
  const config = parseServer(name, rawConfig);
  return config ? { [name]: config } : null;
}

function parseHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
    if (!merged.config.mcpServers[name]) merged.config.mcpServers[name] = server;
  }
  return merged;
}

function expandEnvironmentValue(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, expression: string) => {
    const separator = expression.indexOf(":-");
    const name = separator === -1 ? expression : expression.slice(0, separator);
    const fallback = separator === -1 ? undefined : expression.slice(separator + 2);
    return process.env[name] ?? fallback ?? match;
  });
}

function expandServerEnvironment(server: McpServerConfig): McpServerConfig {
  if (server.type === "stdio") {
    return {
      ...server,
      command: expandEnvironmentValue(server.command),
      args: server.args.map(expandEnvironmentValue),
      ...(server.cwd ? { cwd: expandEnvironmentValue(server.cwd) } : {}),
      ...(server.env
        ? {
            env: Object.fromEntries(
              Object.entries(server.env).map(([k, v]) => [k, expandEnvironmentValue(v)]),
            ),
          }
        : {}),
    };
  }
  return {
    ...server,
    url: expandEnvironmentValue(server.url),
    ...(server.headers
      ? {
          headers: Object.fromEntries(
            Object.entries(server.headers).map(([k, v]) => [k, expandEnvironmentValue(v)]),
          ),
        }
      : {}),
  };
}

export type ProjectMcpServerStatus = "approved" | "rejected" | "pending";

interface ProjectMcpTrustSettings {
  disabled: string[];
  enabled: string[];
  enableAll: boolean;
}

function normalizeMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function loadProjectMcpTrustSettings(cwd: string): Promise<ProjectMcpTrustSettings> {
  const cfg = resolveConfig(cwd);
  const legacyGlobalTrust = cfg.projects?.[canonicalizeCwd(cwd)]?.mcpTrustAccepted === true;
  return {
    disabled: readDisabledFromScope(cfg.disabledMcpjsonServers),
    enabled: readDisabledFromScope(cfg.enabledMcpjsonServers),
    // Migration: legacy blanket trust remains an enable-all fallback, but all new writes use
    // enableAllProjectMcpServers so existing users are not prompted again.
    enableAll:
      cfg.enableAllProjectMcpServers === true || cfg.mcpTrustAccepted === true || legacyGlobalTrust,
  };
}

function projectMcpServerStatus(
  name: string,
  settings: ProjectMcpTrustSettings,
): ProjectMcpServerStatus {
  const normalizedName = normalizeMcpName(name);
  if (settings.disabled.some((candidate) => normalizeMcpName(candidate) === normalizedName)) {
    return "rejected";
  }
  if (
    settings.enabled.some((candidate) => normalizeMcpName(candidate) === normalizedName) ||
    settings.enableAll
  ) {
    return "approved";
  }
  // Noninteractive sessions (`--print`) have no trust dialog to show. Auto-approve
  // pending project servers since project settings are always read for these
  // sessions: the operator explicitly chose print mode, and the CLI's help text
  // warns to only run it in trusted directories.
  if (getRuntimeKind() === "print") {
    return "approved";
  }
  // Yolo (--yolo/--dangerously-skip-permissions) also has no approval popup to
  // show as a bypass-permissions carve-out.
  // isYoloMode() is sourced only from the CLI flag (see yolo-mode.ts), never from
  // project settings, so a malicious .mcp.json cannot self-approve this way.
  if (isYoloMode()) {
    return "approved";
  }
  return "pending";
}

export async function loadProjectMcpServerStatuses(
  cwd: string,
  names: string[],
): Promise<Map<string, ProjectMcpServerStatus>> {
  const settings = await loadProjectMcpTrustSettings(cwd);
  return new Map(names.map((name) => [name, projectMcpServerStatus(name, settings)]));
}

export async function getProjectMcpServerStatus(
  cwd: string,
  name: string,
): Promise<ProjectMcpServerStatus> {
  const settings = await loadProjectMcpTrustSettings(cwd);
  return projectMcpServerStatus(name, settings);
}

function isMcpServerNameEntry(entry: McpServerPolicyEntry): entry is { serverName: string } {
  return "serverName" in entry;
}

function isMcpServerCommandEntry(
  entry: McpServerPolicyEntry,
): entry is { serverCommand: string[] } {
  return "serverCommand" in entry;
}

function isMcpServerUrlEntry(entry: McpServerPolicyEntry): entry is { serverUrl: string } {
  return "serverUrl" in entry;
}

// stdio servers only; returns null for remote (http/sse) servers.
function getServerCommandArray(server: McpServerConfig): string[] | null {
  return server.type === "stdio" ? [server.command, ...server.args] : null;
}

// remote (http/sse) servers only; returns null for stdio servers.
function getServerUrl(server: McpServerConfig): string | null {
  return server.type === "stdio" ? null : server.url;
}

function commandArraysMatch(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function urlPatternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

function urlMatchesPattern(url: string, pattern: string): boolean {
  return urlPatternToRegex(pattern).test(url);
}

/**
 * True if `serverName`/`server` matches a `policySettings.deniedMcpServers`
 * entry (managed-settings.json only — see registry.ts). Checked by name,
 * and, when a server config is available, by exact stdio command array or
 * remote URL pattern.
 */
export function isMcpServerDenied(
  cwd: string,
  serverName: string,
  server?: McpServerConfig,
): boolean {
  const denied = resolveConfig(cwd).deniedMcpServers;
  if (!denied || denied.length === 0) return false;
  if (denied.some((entry) => isMcpServerNameEntry(entry) && entry.serverName === serverName)) {
    return true;
  }
  if (!server) return false;
  const command = getServerCommandArray(server);
  if (
    command &&
    denied.some(
      (entry) => isMcpServerCommandEntry(entry) && commandArraysMatch(entry.serverCommand, command),
    )
  ) {
    return true;
  }
  const url = getServerUrl(server);
  if (
    url &&
    denied.some((entry) => isMcpServerUrlEntry(entry) && urlMatchesPattern(url, entry.serverUrl))
  ) {
    return true;
  }
  return false;
}

/**
 * True if `serverName`/`server` is allowed to connect under
 * `policySettings.deniedMcpServers`/`allowedMcpServers` (managed-settings.json
 * only — see registry.ts). Denylist takes absolute precedence. With no
 * allowlist configured, every non-denied server is allowed; an empty
 * allowlist blocks everything. When the allowlist has any command/URL-typed
 * entries, servers of that kind must match one of them (name-typed entries
 * don't fall back to name matching for a server that has a command/URL).
 * Mirrors upstream isMcpServerAllowedByPolicy.
 */
export function isMcpServerAllowedByPolicy(
  cwd: string,
  serverName: string,
  server?: McpServerConfig,
): boolean {
  if (isMcpServerDenied(cwd, serverName, server)) return false;
  const allowed = resolveConfig(cwd).allowedMcpServers;
  if (!allowed) return true;
  if (allowed.length === 0) return false;

  const command = server ? getServerCommandArray(server) : null;
  const url = server ? getServerUrl(server) : null;

  if (command) {
    if (allowed.some(isMcpServerCommandEntry)) {
      return allowed.some(
        (entry) =>
          isMcpServerCommandEntry(entry) && commandArraysMatch(entry.serverCommand, command),
      );
    }
    return allowed.some((entry) => isMcpServerNameEntry(entry) && entry.serverName === serverName);
  }
  if (url) {
    if (allowed.some(isMcpServerUrlEntry)) {
      return allowed.some(
        (entry) => isMcpServerUrlEntry(entry) && urlMatchesPattern(url, entry.serverUrl),
      );
    }
    return allowed.some((entry) => isMcpServerNameEntry(entry) && entry.serverName === serverName);
  }
  return allowed.some((entry) => isMcpServerNameEntry(entry) && entry.serverName === serverName);
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
    if (!isMcpServerAllowedByPolicy(cwd, name, server)) continue;
    mcpServers[name] = expandServerEnvironment(server);
  }
  return { mcpServers };
}

export async function isProjectMcpTrusted(cwd: string): Promise<boolean> {
  return (await loadProjectMcpTrustSettings(cwd)).enableAll;
}

export async function setProjectMcpTrusted(cwd: string, trusted: boolean): Promise<void> {
  writeProjectSettings(cwd, "local", (file) => {
    if (trusted) file.enableAllProjectMcpServers = true;
    else delete file.enableAllProjectMcpServers;
  });
}

export async function approveProjectMcpServer(
  cwd: string,
  name: string,
  enableAll = false,
): Promise<void> {
  setProjectMcpServerDecision(cwd, name, true, enableAll);
}

export async function rejectProjectMcpServer(cwd: string, name: string): Promise<void> {
  setProjectMcpServerDecision(cwd, name, false, false);
}

function setProjectMcpServerDecision(
  cwd: string,
  name: string,
  approved: boolean,
  enableAll: boolean,
): void {
  writeProjectSettings(cwd, "local", (file) => {
    const enabled = new Set(readDisabledFromScope(file.enabledMcpjsonServers));
    const disabled = new Set(readDisabledFromScope(file.disabledMcpjsonServers));
    if (approved) {
      enabled.add(name);
      disabled.delete(name);
    } else {
      disabled.add(name);
      enabled.delete(name);
    }
    if (enabled.size === 0) delete file.enabledMcpjsonServers;
    else file.enabledMcpjsonServers = [...enabled].sort((a, b) => a.localeCompare(b));
    if (disabled.size === 0) delete file.disabledMcpjsonServers;
    else file.disabledMcpjsonServers = [...disabled].sort((a, b) => a.localeCompare(b));
    if (enableAll) file.enableAllProjectMcpServers = true;
  });
}

export async function hasProjectMcpServers(cwd: string): Promise<boolean> {
  const loaded = await loadEffectiveMcpConfigWithSources(cwd);
  return Object.values(loaded.sources).some((source) => source.scope === "project");
}

function readDisabledFromScope(values: unknown): string[] {
  return (Array.isArray(values) ? values : []).filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
}

export async function loadDisabledMcpServers(cwd: string): Promise<Set<string>> {
  const local = readProjectSettings(cwd, "local");
  const project = readProjectSettings(cwd, "project");
  const cfg = await loadConfig();
  const merged = new Set<string>([
    ...readDisabledFromScope(cfg.disabledMcpServers),
    ...readDisabledFromScope(project.disabledMcpServers),
    ...readDisabledFromScope(local.disabledMcpServers),
  ]);
  return merged;
}

export async function disableMcpServer(cwd: string, name: string): Promise<void> {
  setMcpDisabledFlag(cwd, name, true);
}

export async function enableMcpServer(cwd: string, name: string): Promise<void> {
  setMcpDisabledFlag(cwd, name, false);
}

function setMcpDisabledFlag(cwd: string, name: string, disabled: boolean): void {
  writeProjectSettings(cwd, "local", (file) => {
    const current = new Set(readDisabledFromScope(file.disabledMcpServers));
    if (disabled) current.add(name);
    else current.delete(name);
    if (current.size === 0) delete file.disabledMcpServers;
    else file.disabledMcpServers = [...current].sort((a, b) => a.localeCompare(b));
  });
}
