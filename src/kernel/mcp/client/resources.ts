import { loadEnabledMcpConfig } from "@/kernel/mcp/config.ts";
import {
  hasDirectoryReadCapability,
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
  | { kind: "unknown-server"; available: string[] }
  | { kind: "not-directory"; uri: string }
  | { kind: "no-directory-read"; server: string }
  | { kind: "error"; message: string };

/**
 * List direct children of a directory resource via `resources/directory/read`.
 * Paginates up to MAX_DIRECTORY_PAGES. InvalidParams after page 1 returns
 * accumulated entries; InvalidParams on page 1 => not-directory.
 */
export async function readMcpDirectory(options: {
  cwd: string;
  server: string;
  uri: string;
}): Promise<ReadDirectoryResult> {
  const cfg = await loadEnabledMcpConfig(options.cwd);
  const serverCfg = cfg.mcpServers[options.server];
  if (!serverCfg) {
    return { kind: "unknown-server", available: Object.keys(cfg.mcpServers) };
  }

  try {
    const client = await clientFor(options.server, serverCfg);
    if (!hasDirectoryReadCapability(client.serverCapabilities())) {
      return { kind: "no-directory-read", server: options.server };
    }

    const entries: McpDirectoryEntry[] = [];
    let cursor: string | undefined;
    let page = 0;

    do {
      let pageResult: Awaited<ReturnType<typeof client.listDirectory>>;
      try {
        pageResult = await client.listDirectory(options.uri, cursor ? { cursor } : undefined);
      } catch (err) {
        if (isInvalidParams(err)) {
          if (page === 0) return { kind: "not-directory", uri: options.uri };
          // Some servers reject cursor pagination after page 1 — keep prior pages.
          break;
        }
        throw err;
      }

      for (const entry of pageResult.resources) {
        entries.push({
          uri: sanitizeMcpUri(entry.uri),
          name: sanitizeMcpText(entry.name),
          ...(entry.description !== undefined
            ? { description: sanitizeMcpText(entry.description) }
            : {}),
          ...(entry.mimeType !== undefined ? { mimeType: sanitizeMcpText(entry.mimeType) } : {}),
        });
      }
      cursor = pageResult.nextCursor;
      page++;
    } while (cursor && page < MAX_DIRECTORY_PAGES);

    return { kind: "ok", resources: entries };
  } catch (e) {
    if (isInvalidParams(e)) return { kind: "not-directory", uri: options.uri };
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
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
