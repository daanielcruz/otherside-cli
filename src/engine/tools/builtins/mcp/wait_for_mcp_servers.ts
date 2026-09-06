import type { ToolHandler } from "@/engine/tools/contract.ts";
import { inspectServer } from "@/kernel/mcp/client/registry.ts";
import { loadEnabledMcpConfig } from "@/kernel/mcp/config.ts";
import { isEnvDefinedFalsy, isEnvTruthy } from "@/kernel/std/proc/env.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const SERVER_WAIT_LIMIT_MS = 5000;

export type SearchCatalogPolicy = "tst" | "tst-auto" | "standard";

export function readAutomaticShare(value: string): number | null {
  if (!value.startsWith("auto:")) return null;
  const percentage = parseInt(value.slice(5), 10);
  if (Number.isNaN(percentage)) return null;
  return Math.max(0, Math.min(100, percentage));
}

export function resolveSearchCatalogPolicy(): SearchCatalogPolicy {
  const setting = process.env.ENABLE_TOOL_SEARCH;
  const percentage = setting ? readAutomaticShare(setting) : null;
  if (percentage === 0) return "tst";
  if (percentage === 100) return "standard";
  if (setting === "auto" || setting?.startsWith("auto:") === true) return "tst-auto";
  if (isEnvTruthy(setting)) return "tst";
  if (isEnvDefinedFalsy(setting)) return "standard";
  return "tst";
}

type ServerConnectionStatus =
  | "connected"
  | "failed"
  | "pending"
  | "needs-auth"
  | "disabled"
  | string;

interface ServerConnection {
  name: string;
  type: ServerConnectionStatus;
}

interface WaitOutput {
  ready: boolean;
  connected: string[];
  failed: string[];
  stillPending: string[];
  needsAuth: string[];
  disabled: string[];
  unknown: string[];
}

function ok(toolUseId: string, payload: WaitOutput): ToolResult {
  return { tool_use_id: toolUseId, content: JSON.stringify(payload) };
}

async function readConnections(cwd: string): Promise<ServerConnection[]> {
  try {
    const cfg = await loadEnabledMcpConfig(cwd);
    const names = Object.keys(cfg.mcpServers);
    const results = await Promise.all(
      names.map(async (serverName) => {
        const serverCfg = cfg.mcpServers[serverName];
        if (!serverCfg) return null;
        const inspection = await inspectServer(serverName, serverCfg);
        const type: ServerConnectionStatus =
          inspection.status === "connected"
            ? "connected"
            : inspection.status === "needs-auth"
              ? "needs-auth"
              : "failed";
        return { name: serverName, type } satisfies ServerConnection;
      }),
    );
    return results.filter((result): result is ServerConnection => result !== null);
  } catch {
    return [];
  }
}

async function awaitConnectionSettling(
  targets: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<ServerConnection[]> {
  const targetNames = new Set(targets);
  const expiresAt = Date.now() + SERVER_WAIT_LIMIT_MS;
  let connections = await readConnections(cwd);
  while (Date.now() < expiresAt && !signal?.aborted) {
    const waiting = connections.some(
      (connection) => targetNames.has(connection.name) && connection.type === "pending",
    );
    if (!waiting) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    connections = await readConnections(cwd);
  }
  return connections;
}

async function connectionNamesInFlight(cwd: string): Promise<string[]> {
  const connections = await readConnections(cwd);
  return connections
    .filter((connection) => connection.type === "pending")
    .map((connection) => connection.name);
}

function connectionOutcome(
  type: ServerConnectionStatus | undefined,
): keyof Omit<WaitOutput, "ready"> {
  if (type === "connected") return "connected";
  if (type === "failed") return "failed";
  if (type === "pending") return "stillPending";
  if (type === "needs-auth") return "needsAuth";
  if (type === "disabled") return "disabled";
  return "unknown";
}

function projectConnectionOutcomes(targets: string[], connections: ServerConnection[]): WaitOutput {
  const byName = new Map(connections.map((connection) => [connection.name, connection.type]));
  const output: WaitOutput = {
    ready: false,
    connected: [],
    failed: [],
    stillPending: [],
    needsAuth: [],
    disabled: [],
    unknown: [],
  };
  for (const name of targets) output[connectionOutcome(byName.get(name))].push(name);
  output.ready = [
    output.failed,
    output.stillPending,
    output.needsAuth,
    output.disabled,
    output.unknown,
  ].every((names) => names.length === 0);
  return output;
}

export const MISSING_MCP_TOOLS_WAITER: ToolHandler = {
  schema: {
    name: "WaitForMcpServers",
    description: [
      "Wait for MCP servers that are still connecting and whose tools are not",
      "yet in your tool list. Pass `servers` to wait for specific ones, or omit",
      "it to wait for all pending servers.",
      "",
      "If the user's request needs tools from a still-connecting server, call this",
      "tool to wait for it. Once it connects, its tools will be added to your tool",
      "list and you can use them directly. Returns ready=true when servers are",
      "ready, ready=false if they failed to connect, need authentication, or are",
      "disabled.",
      "",
      "You do not need to ask the user for confirmation to use this tool.",
    ].join("\n"),
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        servers: {
          type: "array",
          items: { type: "string" },
          description: "Server names to wait for (default: all pending)",
        },
      },
      additionalProperties: false,
    },
  },
  isConcurrencySafe: false,
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const input = (call.input ?? {}) as { servers?: unknown };
    const servers = Array.isArray(input.servers)
      ? input.servers.filter((s): s is string => typeof s === "string")
      : null;

    const targets =
      servers && servers.length > 0 ? servers : await connectionNamesInFlight(ctx.cwd);

    if (targets.length === 0) {
      return ok(call.id, projectConnectionOutcomes([], []));
    }

    const connections = await awaitConnectionSettling(targets, ctx.cwd);
    const output = projectConnectionOutcomes(targets, connections);
    const lines = [
      `ready: ${output.ready}`,
      output.connected.length
        ? `Connected (their tools are now available — call them directly): ${output.connected.join(", ")}`
        : "",
      output.failed.length ? `Failed to connect: ${output.failed.join(", ")}` : "",
      output.stillPending.length
        ? `Still connecting (try again or proceed without): ${output.stillPending.join(", ")}`
        : "",
      output.needsAuth.length
        ? `Needs authentication (ask the user to run /mcp): ${output.needsAuth.join(", ")}`
        : "",
      output.disabled.length
        ? `Disabled (ask the user to enable via /mcp): ${output.disabled.join(", ")}`
        : "",
      output.unknown.length
        ? `Unknown (no MCP server with this name is configured): ${output.unknown.join(", ")}`
        : "",
    ].filter(Boolean);

    return {
      tool_use_id: call.id,
      content: lines.join("\n"),
      is_error: !output.ready,
    };
  },
};
