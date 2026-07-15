import type { ToolHandler } from "@/engine/tools/contract.ts";
import { inspectServer } from "@/kernel/mcp/client/registry.ts";
import { loadEnabledMcpConfig } from "@/kernel/mcp/config.ts";
import { isEnvDefinedFalsy, isEnvTruthy } from "@/kernel/std/proc/env.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const WAIT_TIMEOUT_MS = 5000;

export type ToolSearchMode = "tst" | "tst-auto" | "standard";

export function parseAutoPercentage(value: string): number | null {
  if (!value.startsWith("auto:")) return null;
  const pct = parseInt(value.slice(5), 10);
  if (Number.isNaN(pct)) return null;
  return Math.max(0, Math.min(100, pct));
}

function isAutoToolSearchMode(value: string | undefined): boolean {
  if (!value) return false;
  return value === "auto" || value.startsWith("auto:");
}

export function getToolSearchMode(): ToolSearchMode {
  const value = process.env.ENABLE_TOOL_SEARCH;
  const autoPercent = value ? parseAutoPercentage(value) : null;
  if (autoPercent === 0) return "tst";
  if (autoPercent === 100) return "standard";
  if (isAutoToolSearchMode(value)) return "tst-auto";
  if (isEnvTruthy(value)) return "tst";
  if (isEnvDefinedFalsy(process.env.ENABLE_TOOL_SEARCH)) return "standard";
  return "tst";
}

type McpStatus = "connected" | "failed" | "pending" | "needs-auth" | "disabled" | string;

interface McpClientState {
  name: string;
  type: McpStatus;
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

async function snapshotMcpClients(cwd: string): Promise<McpClientState[]> {
  try {
    const cfg = await loadEnabledMcpConfig(cwd);
    const names = Object.keys(cfg.mcpServers);
    const results = await Promise.all(
      names.map(async (serverName) => {
        const serverCfg = cfg.mcpServers[serverName];
        if (!serverCfg) return null;
        const inspection = await inspectServer(serverName, serverCfg);
        const type: McpStatus =
          inspection.status === "connected"
            ? "connected"
            : inspection.status === "needs-auth"
              ? "needs-auth"
              : "failed";
        return { name: serverName, type } satisfies McpClientState;
      }),
    );
    return results.filter((r): r is McpClientState => r !== null);
  } catch {
    return [];
  }
}

async function waitForClients(
  targets: string[],
  cwd: string,
  abortSignal?: AbortSignal,
): Promise<McpClientState[]> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let current = await snapshotMcpClients(cwd);
  while (Date.now() < deadline && !abortSignal?.aborted) {
    const targetSet = new Set(targets);
    const matching = current.filter((c) => targetSet.has(c.name));
    const allSettled = matching.every((c) => c.type !== "pending");
    if (allSettled) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    current = await snapshotMcpClients(cwd);
  }
  return current;
}

async function getAllPending(cwd: string): Promise<string[]> {
  const clients = await snapshotMcpClients(cwd);
  return clients.filter((c) => c.type === "pending").map((c) => c.name);
}

export const WaitForMcpServersTool: ToolHandler = {
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

    const targets = servers && servers.length > 0 ? servers : await getAllPending(ctx.cwd);

    if (targets.length === 0) {
      const result: WaitOutput = {
        ready: true,
        connected: [],
        failed: [],
        stillPending: [],
        needsAuth: [],
        disabled: [],
        unknown: [],
      };
      return ok(call.id, result);
    }

    const allClients = await waitForClients(targets, ctx.cwd);
    const clientMap = new Map(allClients.map((c) => [c.name, c]));

    const connected: string[] = [];
    const failed: string[] = [];
    const stillPending: string[] = [];
    const needsAuth: string[] = [];
    const disabled: string[] = [];
    const unknown: string[] = [];

    for (const name of targets) {
      const client = clientMap.get(name);
      if (!client) {
        unknown.push(name);
        continue;
      }
      switch (client.type) {
        case "connected":
          connected.push(name);
          break;
        case "failed":
          failed.push(name);
          break;
        case "pending":
          stillPending.push(name);
          break;
        case "needs-auth":
          needsAuth.push(name);
          break;
        case "disabled":
          disabled.push(name);
          break;
        default:
          unknown.push(name);
      }
    }

    const ready =
      stillPending.length === 0 &&
      failed.length === 0 &&
      needsAuth.length === 0 &&
      disabled.length === 0 &&
      unknown.length === 0;

    const lines = [
      `ready: ${ready}`,
      connected.length
        ? `Connected (their tools are now available — call them directly): ${connected.join(", ")}`
        : "",
      failed.length ? `Failed to connect: ${failed.join(", ")}` : "",
      stillPending.length
        ? `Still connecting (try again or proceed without): ${stillPending.join(", ")}`
        : "",
      needsAuth.length
        ? `Needs authentication (ask the user to run /mcp): ${needsAuth.join(", ")}`
        : "",
      disabled.length ? `Disabled (ask the user to enable via /mcp): ${disabled.join(", ")}` : "",
      unknown.length
        ? `Unknown (no MCP server with this name is configured): ${unknown.join(", ")}`
        : "",
    ].filter(Boolean);

    return {
      tool_use_id: call.id,
      content: lines.join("\n"),
      is_error: !ready,
    };
  },
};
