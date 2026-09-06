import { buildDynamicMcpAuthTools } from "@/kernel/mcp/auth/dynamic-tools.ts";
import { dispatchMcp } from "@/kernel/mcp/client/dispatch.ts";
import {
  type McpInstructionBlock,
  setMcpInstructionBlocks,
} from "@/kernel/mcp/client/instructions.ts";
import { marshalMcpContent } from "@/kernel/mcp/client/output/handler.ts";
import {
  clientFor,
  clientForNamespace,
  dropClient,
  dropClientsForNamespace,
  keepOnlyClients,
  mcpServerStatuses,
} from "@/kernel/mcp/client/registry.ts";
import { notifyMcpServerUsed } from "@/kernel/mcp/client/use-listener.ts";
import { loadEnabledMcpConfig, loadFlagMcpServers } from "@/kernel/mcp/config.ts";
import { formatMcpToolLabel, type McpCallIdentity } from "@/kernel/mcp/protocol/tool-label.ts";
import {
  type McpClient,
  type McpJsonConfig,
  type McpServerConfig,
  type McpToolInfo,
  UnauthorizedError,
} from "@/kernel/mcp/protocol/types.ts";
import { parseWireToolName, wireToolName } from "@/kernel/mcp/protocol/wire-name.ts";
import { isAbortError } from "@/kernel/std/stream/abort.ts";
import type { ToolHandler, ToolRenderHooks } from "@/kernel/std/tool-contract.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export {
  getMcpConnectionErrorCount,
  isTerminalMcpError,
  MAX_ERRORS_BEFORE_RECONNECT,
  RETRY_BACKOFF_MS,
  recordMcpConnectionError,
  resetMcpConnectionErrors,
  scheduleReconnect,
} from "@/kernel/mcp/runtime/reconnect.ts";

export interface McpRuntime {
  handlers: ToolHandler[];
  instructions: McpInstructionBlock[];
}

export interface NamespacedMcpRuntime extends McpRuntime {
  failures: { server: string; error: string }[];
  close(): Promise<void>;
}

export interface McpConnectivityReport {
  connected: string[];
  failed: { server: string; error: string }[];
  needsAuth: { server: string; error: string }[];
}

export interface ToolRegistryPort {
  register: (handler: ToolHandler) => void;
  registerWithNamespace: (namespace: `mcp:${string}`, handler: ToolHandler) => void;
  unregister: (name: string) => void;
}

let toolRegistry: ToolRegistryPort | null = null;

export function setMcpToolRegistry(port: ToolRegistryPort): void {
  toolRegistry = port;
}

const registeredMcpToolNames = new Set<string>();

export async function loadMcpToolHandlers(cwd: string = process.cwd()): Promise<ToolHandler[]> {
  return (await loadMcpRuntime(cwd)).handlers;
}

export function getMcpServerStatuses(names: string[]): ReturnType<typeof mcpServerStatuses> {
  return mcpServerStatuses(names);
}

export async function loadMcpRuntime(cwd: string = process.cwd()): Promise<McpRuntime> {
  const cfg = await safeLoadConfig(cwd);
  return buildMcpRuntime(cfg.mcpServers);
}

// Connect first; only expose OAuth stubs when the server actually returned
// needs-auth. Credential-less HTTP that fails for any other reason (wrong
// endpoint, JSON-RPC plugin, dead local port) must not advertise authenticate.
export async function buildMcpRuntime(
  servers: Record<string, McpServerConfig>,
): Promise<McpRuntime> {
  const handlers: ToolHandler[] = [];
  const instructions: McpInstructionBlock[] = [];
  const needsAuth: Record<string, McpServerConfig> = {};
  for (const serverName of Object.keys(servers).sort()) {
    const serverCfg = servers[serverName];
    if (!serverCfg) continue;
    const collected = await collectServerHandlers(serverName, serverCfg);
    if (collected.kind === "connected") {
      if (collected.instructionText) {
        instructions.push({ server: serverName, text: collected.instructionText });
      }
      for (const handler of collected.handlers) handlers.push(handler);
      continue;
    }
    if (collected.kind === "needs-auth") needsAuth[serverName] = serverCfg;
  }
  for (const handler of buildDynamicMcpAuthTools(needsAuth, refreshAuthenticatedMcpServer)) {
    handlers.push(handler);
  }
  return { handlers, instructions };
}

export async function loadNamespacedMcpRuntime(options: {
  namespace: string;
  servers: Record<string, McpServerConfig>;
}): Promise<NamespacedMcpRuntime> {
  const handlers: ToolHandler[] = [];
  const instructions: McpInstructionBlock[] = [];
  const failures: { server: string; error: string }[] = [];
  const { namespace, servers } = options;
  for (const serverName of Object.keys(servers).sort()) {
    const serverCfg = servers[serverName];
    if (!serverCfg) continue;
    try {
      const client = await clientForNamespace(namespace, serverName, serverCfg);
      const instructionText = client.serverInstructions();
      const tools = await client.listTools();
      if (instructionText) instructions.push({ server: serverName, text: instructionText });
      for (const tool of tools) handlers.push(makeClientBoundHandler({ serverName, tool, client }));
    } catch (error) {
      failures.push({
        server: serverName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    handlers,
    instructions,
    failures,
    close: () => dropClientsForNamespace(namespace),
  };
}

async function safeLoadConfig(cwd: string): Promise<McpJsonConfig> {
  let config: McpJsonConfig;
  try {
    config = await loadEnabledMcpConfig(cwd);
  } catch {
    config = { mcpServers: {} };
  }
  // Fold in --mcp-config flag servers (local scope, trust-exempt) so the
  // interactive path honors them like the print path does. A malformed entry
  // drops only the flag servers; the project chain already loaded stays intact.
  try {
    const flagServers = loadFlagMcpServers(cwd);
    if (Object.keys(flagServers).length > 0) {
      config = { ...config, mcpServers: { ...config.mcpServers, ...flagServers } };
    }
  } catch {
    // Flag servers unavailable; keep the project-chain config unchanged.
  }
  return config;
}

type CollectedServer =
  | { kind: "connected"; handlers: ToolHandler[]; instructionText: string | null }
  | { kind: "needs-auth"; error: string }
  | { kind: "failed"; error: string };

async function collectServerHandlers(
  serverName: string,
  serverCfg: McpServerConfig,
): Promise<CollectedServer> {
  try {
    const client = await clientFor(serverName, serverCfg);
    const instructionText = client.serverInstructions();
    const tools = await client.listTools();
    return {
      kind: "connected",
      instructionText,
      handlers: tools.map((tool) => makeHandler({ serverName, tool })),
    };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return { kind: "needs-auth", error: error.message };
    }
    return {
      kind: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function refreshAuthenticatedMcpServer(options: {
  serverName: string;
  config: McpServerConfig;
  cwd: string;
}): Promise<void> {
  await dropClient(options.serverName, options.config);
  await refreshMcpTools(options.cwd);
}

export async function refreshMcpTools(cwd: string = process.cwd()): Promise<void> {
  const runtime = await loadMcpRuntime(cwd);
  const cfg = await safeLoadConfig(cwd);
  const activeServers = Object.entries(cfg.mcpServers)
    .filter(([_, config]) => !!config)
    .map(([name, config]) => ({ name, config: config! }));
  await keepOnlyClients(activeServers);

  const reg = toolRegistry;
  if (!reg) return;
  for (const name of registeredMcpToolNames) reg.unregister(name);
  registeredMcpToolNames.clear();
  for (const handler of runtime.handlers) {
    const parsed = parseWireToolName(handler.schema.name);
    if (parsed) {
      reg.registerWithNamespace(`mcp:${parsed[0]}`, handler);
    } else {
      reg.register(handler);
    }
    registeredMcpToolNames.add(handler.schema.name);
  }
  setMcpInstructionBlocks(runtime.instructions);
}

export async function probeMcpConnectivity(
  cwd: string = process.cwd(),
): Promise<McpConnectivityReport> {
  const report: McpConnectivityReport = { connected: [], failed: [], needsAuth: [] };
  const cfg = await safeLoadConfig(cwd);
  const names = Object.keys(cfg.mcpServers).sort();
  const { inspectServer } = await import("@/kernel/mcp/client/registry.ts");
  await Promise.all(
    names.map(async (serverName) => {
      const serverCfg = cfg.mcpServers[serverName];
      if (!serverCfg) return;
      const inspection = await inspectServer(serverName, serverCfg);
      if (inspection.status === "connected") report.connected.push(serverName);
      else if (inspection.status === "needs-auth") {
        report.needsAuth.push({ server: serverName, error: inspection.error ?? "needs auth" });
      } else if (inspection.status === "failed") {
        report.failed.push({ server: serverName, error: inspection.error ?? "connection failed" });
      }
    }),
  );
  return report;
}

function makeHandler(options: { serverName: string; tool: McpToolInfo }): ToolHandler {
  const { serverName, tool } = options;
  const name = wireToolName(serverName, tool.name);
  const description = mcpToolDescription(tool);
  return {
    schema: { name, description, inputSchema: tool.inputSchema },
    render: makeMcpRenderHooks(serverName, tool),
    isConcurrencySafe: tool.readOnlyHint === true,
    async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
      return dispatchMcp({
        toolUseId: call.id,
        toolName: call.name,
        args: call.input ?? {},
        persistCtx: { cwd: ctx.cwd, sessionId: ctx.sessionId },
        ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      });
    },
  };
}

function makeClientBoundHandler(options: {
  serverName: string;
  tool: McpToolInfo;
  client: McpClient;
}): ToolHandler {
  const { serverName, tool, client } = options;
  const name = wireToolName(serverName, tool.name);
  return {
    schema: {
      name,
      description: mcpToolDescription(tool),
      inputSchema: tool.inputSchema,
    },
    render: makeMcpRenderHooks(serverName, tool),
    isConcurrencySafe: tool.readOnlyHint === true,
    async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
      try {
        if (ctx.abortSignal?.aborted) {
          return { tool_use_id: call.id, content: "Interrupted by user", is_error: true };
        }
        const result = await client.callTool(
          tool.name,
          call.input ?? {},
          ctx.abortSignal ? { signal: ctx.abortSignal } : undefined,
        );
        notifyMcpServerUsed(serverName);
        const { content, isError } = marshalMcpContent(result, {
          cwd: ctx.cwd,
          sessionId: ctx.sessionId,
          serverName,
          toolName: tool.name,
          toolUseId: call.id,
        });
        if (isError) return { tool_use_id: call.id, content, is_error: true };
        return { tool_use_id: call.id, content };
      } catch (error) {
        if (isAbortError(error) || ctx.abortSignal?.aborted) {
          return { tool_use_id: call.id, content: "Interrupted by user", is_error: true };
        }
        return {
          tool_use_id: call.id,
          content: error instanceof Error ? error.message : String(error),
          is_error: true,
        };
      }
    },
  };
}

// Wire cap for an MCP tool's schema description (2048 chars, surrogate-safe
// slice, "… [truncated]" marker). The tool's own description goes out
// verbatim below the cap — server attribution lives in the wire name, never
// prepended here — and an empty description stays empty.
const MCP_TOOL_DESCRIPTION_MAX_CHARS = 2048;

export function mcpToolDescription(tool: Pick<McpToolInfo, "description">): string {
  const description = tool.description;
  if (description.length <= MCP_TOOL_DESCRIPTION_MAX_CHARS) return description;
  let head = description.slice(0, MCP_TOOL_DESCRIPTION_MAX_CHARS);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head}… [truncated]`;
}

export function makeMcpRenderHooks(
  serverName: string,
  tool: Pick<McpToolInfo, "name" | "title" | "description">,
): ToolRenderHooks {
  const identity = mcpCallIdentityOf(serverName, tool);
  return {
    userFacingLabel: () => formatMcpToolLabel(identity),
    // The tool's own description, unprefixed — the permission prompt shows it
    // under the header line; the server attribution already lives in the label.
    userFacingDescription: () => tool.description,
    summarizeArgs: (input) => mcpArgsSummary(input),
    formatResult: (text) => text.replace(MCP_IMAGE_PLACEHOLDER_RE, "[Image]"),
  };
}

/**
 * Identity by wire name for every tool this process has built a handler for.
 * Keyed on the wire name because that is all a recorded call carries. Entries
 * outlive their server on purpose: a server that drops mid-session should not
 * take the naming of the calls it already served with it.
 */
const identityByWireName = new Map<string, McpCallIdentity>();

function mcpCallIdentityOf(
  serverName: string,
  tool: Pick<McpToolInfo, "name" | "title">,
): McpCallIdentity {
  const identity: McpCallIdentity = { server: serverName, tool: tool.title || tool.name };
  identityByWireName.set(wireToolName(serverName, tool.name), identity);
  return identity;
}

/** The identity to record with a call, or null when no server here declared it. */
export function mcpCallIdentity(wireName: string): McpCallIdentity | null {
  return identityByWireName.get(wireName) ?? null;
}

const MCP_IMAGE_PLACEHOLDER_RE = /\[image:[^\]]*\]/g;

function mcpArgsSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return "";
  return entries
    .map(([key, value]) => {
      const rendered = JSON.stringify(value) ?? String(value);
      return `${key}: ${rendered}`;
    })
    .join(", ");
}
