import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import * as plugins from "@/engine/plugins/registry.ts";
import type { McpServerConfig as RuntimeMcpServerConfig } from "@/kernel/mcp/protocol/types.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { expandPluginRoot, PLUGIN_ROOT_ENV } from "@/kernel/std/fs/plugin-root.ts";
import {
  type McpServerConfig as ManifestMcpServerConfig,
  McpServerConfigSchema,
} from "./manifest.ts";

function resolveMaybePath(
  value: string,
  pluginDir: string,
  existsSyncFn: (path: string) => boolean,
): string {
  const expanded = expandPluginRoot(value, pluginDir);
  if (isAbsolute(expanded) || expanded.startsWith("-")) return expanded;
  const candidate = join(pluginDir, expanded);
  return existsSyncFn(candidate) ? candidate : expanded;
}

function pluginDataDir(pluginSource: string): string {
  const safeId = pluginSource.replace(/[^a-zA-Z0-9_-]/g, "-");
  const dir = join(configRoot(), "plugins", "data", safeId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function pluginServerEnv(
  env: Record<string, string> | undefined,
  pluginDir: string,
  pluginSource: string,
): Record<string, string> {
  const out: Record<string, string> = {
    [PLUGIN_ROOT_ENV]: pluginDir,
    CLAUDE_PLUGIN_DATA: pluginDataDir(pluginSource),
  };
  if (env) {
    for (const [key, value] of Object.entries(env)) out[key] = expandPluginRoot(value, pluginDir);
  }
  return out;
}

function expandHeaders(
  headers: Record<string, string> | undefined,
  pluginDir: string,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key] = expandPluginRoot(value, pluginDir);
  return out;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(canonicalPath(root), canonicalPath(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function parseServerRecord(raw: unknown): Record<string, ManifestMcpServerConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const root = raw as Record<string, unknown>;
  const candidate =
    root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)
      ? (root.mcpServers as Record<string, unknown>)
      : root;
  const servers: Record<string, ManifestMcpServerConfig> = {};
  for (const [name, value] of Object.entries(candidate)) {
    const parsed = McpServerConfigSchema.safeParse(value);
    if (parsed.success) servers[name] = parsed.data;
  }
  return servers;
}

function loadServerRecord(
  pluginDir: string,
  relativePath: string,
): Record<string, ManifestMcpServerConfig> {
  const path = resolve(pluginDir, relativePath);
  if (!isWithinRoot(pluginDir, path)) return {};
  try {
    return parseServerRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

function pluginServerRecords(
  pluginDir: string,
  spec: unknown,
): Record<string, ManifestMcpServerConfig> {
  const records: Record<string, ManifestMcpServerConfig> = loadServerRecord(pluginDir, ".mcp.json");
  const items = Array.isArray(spec) ? spec : spec === undefined ? [] : [spec];
  for (const item of items) {
    const next =
      typeof item === "string" ? loadServerRecord(pluginDir, item) : parseServerRecord(item);
    Object.assign(records, next);
  }
  return records;
}

function adaptServer(
  server: ManifestMcpServerConfig,
  pluginDir: string,
  pluginId: string,
  existsSyncFn: (path: string) => boolean,
): RuntimeMcpServerConfig | null {
  if (
    (server.type === undefined || server.type === "stdio") &&
    typeof server.command === "string"
  ) {
    const expandedCwd = server.cwd ? expandPluginRoot(server.cwd, pluginDir) : undefined;
    const cwd = expandedCwd
      ? isAbsolute(expandedCwd)
        ? expandedCwd
        : resolve(pluginDir, expandedCwd)
      : undefined;
    return {
      type: "stdio",
      command: resolveMaybePath(server.command, pluginDir, existsSyncFn),
      args: (server.args ?? []).map((a) => resolveMaybePath(a, pluginDir, existsSyncFn)),
      env: pluginServerEnv(server.env, pluginDir, pluginId),
      ...(cwd ? { cwd } : {}),
    };
  }
  if (
    (server.type === undefined || server.type === "http" || server.type === "sse") &&
    typeof server.url === "string"
  ) {
    const headers = expandHeaders(server.headers, pluginDir);
    const oauthScopes = server.oauth?.scope;
    return {
      type: server.type === "sse" ? "sse" : "http",
      url: expandPluginRoot(server.url, pluginDir),
      ...(headers ? { headers } : {}),
      ...(oauthScopes ? { oauthScopes } : {}),
    };
  }
  return null;
}

export function gatherPluginMcpServers(options?: {
  existsSync?: (path: string) => boolean;
}): Record<string, RuntimeMcpServerConfig> {
  const existsSyncFn = options?.existsSync ?? existsSync;
  const out: Record<string, RuntimeMcpServerConfig> = {};
  for (const plugin of plugins.list()) {
    if (!plugins.isRuntimeEnabled(plugin.name)) continue;
    const records = pluginServerRecords(plugin.path, plugin.manifest.mcpServers);
    for (const [serverName, server] of Object.entries(records)) {
      const adapted = adaptServer(
        server,
        plugin.path,
        `${plugin.name}@${plugin.source}`,
        existsSyncFn,
      );
      if (adapted) out[`plugin:${plugin.name}:${serverName}`] = adapted;
    }
  }
  return out;
}
