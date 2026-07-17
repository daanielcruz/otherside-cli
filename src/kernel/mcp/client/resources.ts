import { loadEnabledMcpConfig } from "@/kernel/mcp/config.ts";
import {
  hasDirectoryReadCapability,
  hasResourcesCapability,
  isMcpSkillsEnabled,
  sanitizeMcpText,
  sanitizeMcpUri,
} from "@/kernel/mcp/protocol/parse.ts";
import type { McpDirectoryEntry, McpResourceInfo } from "@/kernel/mcp/protocol/types.ts";
import {
  MAX_DIRECTORY_PAGES,
  MAX_MCP_RESOURCE_OUTPUT_CHARS,
  MCP_INVALID_PARAMS,
  McpRpcError,
} from "@/kernel/mcp/protocol/types.ts";
import { clientFor } from "./registry.ts";

export interface ScopedResource extends McpResourceInfo {
  server: string;
}

export async function listMcpResources(options: {
  cwd: string;
  server?: string;
}): Promise<ScopedResource[]> {
  const cfg = await loadEnabledMcpConfig(options.cwd);
  const names = options.server ? [options.server] : Object.keys(cfg.mcpServers);
  const resources: ScopedResource[] = [];
  for (const name of names) {
    const serverCfg = cfg.mcpServers[name];
    if (!serverCfg) continue;
    try {
      const client = await clientFor(name, serverCfg);
      const items = await client.listResources();
      for (const item of items) resources.push({ ...item, server: name });
    } catch {}
  }
  return resources;
}

export type ReadResourceResult =
  | { kind: "ok"; contents: unknown[] }
  | { kind: "unknown-server"; available: string[] }
  | { kind: "error"; message: string };

export async function readMcpResource(options: {
  cwd: string;
  server: string;
  uri: string;
}): Promise<ReadResourceResult> {
  const cfg = await loadEnabledMcpConfig(options.cwd);
  const serverCfg = cfg.mcpServers[options.server];
  if (!serverCfg) {
    return { kind: "unknown-server", available: Object.keys(cfg.mcpServers) };
  }
  try {
    const client = await clientFor(options.server, serverCfg);
    const result = (await client.readResource(options.uri)) as { contents?: unknown } | null;
    const contents = Array.isArray(result?.contents) ? result.contents : [];
    return { kind: "ok", contents };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

export type ReadDirectoryResult =
  | { kind: "ok"; resources: McpDirectoryEntry[] }
  | { kind: "controlled-error"; message: string };

/** Claude's MCP wire-name normalization: exact names win, then normalized names. */
export function normalizeMcpServerName(name: string): string {
  let normalized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (name.startsWith("claude.ai ")) {
    normalized = normalized.replace(/_+/g, "_").replace(/^_|_$/g, "");
  }
  return normalized;
}

function resolveConfiguredServerName(
  requested: string,
  available: readonly string[],
): string | undefined {
  const exact = available.find((name) => name === requested);
  if (exact !== undefined) return exact;
  const normalized = normalizeMcpServerName(requested);
  return available.find((name) => normalizeMcpServerName(name) === normalized);
}

/**
 * List direct children of a directory resource via `resources/directory/read`.
 * Paginates up to MAX_DIRECTORY_PAGES. InvalidParams after page 1 returns
 * accumulated entries; InvalidParams on page 1 is a controlled tool result.
 */
export async function readMcpDirectory(options: {
  cwd: string;
  server: string;
  uri: string;
}): Promise<ReadDirectoryResult> {
  const cfg = await loadEnabledMcpConfig(options.cwd);
  const available = Object.keys(cfg.mcpServers);
  const serverName = resolveConfiguredServerName(options.server, available);
  if (serverName === undefined) {
    throw new Error(
      `Server "${options.server}" not found. Available servers: ${available.join(", ")}`,
    );
  }
  const serverCfg = cfg.mcpServers[serverName];
  if (serverCfg === undefined) {
    throw new Error(`Server "${options.server}" not found`);
  }

  const client = await clientFor(serverName, serverCfg);
  const capabilities = client.serverCapabilities();
  if (!hasResourcesCapability(capabilities)) {
    throw new Error(`Server "${serverName}" does not support resources`);
  }
  if (!isMcpSkillsEnabled()) {
    return {
      kind: "controlled-error",
      message: "Directory listing is not enabled in this build.",
    };
  }
  if (!hasDirectoryReadCapability(capabilities)) {
    return {
      kind: "controlled-error",
      message: `Server "${serverName}" does not support directory listing.`,
    };
  }

  const entries: McpDirectoryEntry[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    let pageResult: Awaited<ReturnType<typeof client.listDirectory>>;
    try {
      pageResult = await client.listDirectory(options.uri, cursor ? { cursor } : undefined);
    } catch (error) {
      if (!isInvalidParams(error)) throw error;
      if (page === 0) {
        return {
          kind: "controlled-error",
          message: `Not a directory resource: ${options.uri}. If it is a file resource, use ReadMcpResourceTool instead.`,
        };
      }
      break;
    }

    for (const entry of pageResult.resources) {
      entries.push({
        uri: sanitizeMcpUri(entry.uri),
        name: sanitizeMcpText(entry.name),
        ...(entry.mimeType !== undefined ? { mimeType: sanitizeMcpText(entry.mimeType) } : {}),
      });
    }
    cursor = pageResult.nextCursor;
    page++;
  } while (cursor && page < MAX_DIRECTORY_PAGES);

  return { kind: "ok", resources: entries };
}

export function boundMcpResourceOutput(payload: unknown): string {
  const raw = JSON.stringify(payload);
  if (raw.length <= MAX_MCP_RESOURCE_OUTPUT_CHARS) return raw;
  return `${raw.slice(0, MAX_MCP_RESOURCE_OUTPUT_CHARS)}\n...[truncated]`;
}

function isInvalidParams(err: unknown): boolean {
  if (err instanceof McpRpcError) return err.code === MCP_INVALID_PARAMS;
  if (!(err instanceof Error)) return false;
  // Fallback for non-McpRpcError throws that still embed the JSON-RPC code.
  const match = /"code"\s*:\s*(-?\d+)/.exec(err.message);
  return match?.[1] === String(MCP_INVALID_PARAMS);
}
