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
import { loadEnabledMcpConfig } from "@/kernel/mcp/config.ts";
import {
  type McpClient,
  type McpJsonConfig,
  type McpServerConfig,
  type McpToolInfo,
  UnauthorizedError,
} from "@/kernel/mcp/protocol/types.ts";
import { parseWireToolName, wireToolName } from "@/kernel/mcp/protocol/wire-name.ts";
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
  try {
    return await loadEnabledMcpConfig(cwd);
  } catch {
    return { mcpServers: {} };
  }
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
  const description = mcpToolDescription(serverName, tool);
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
      description: mcpToolDescription(serverName, tool),
      inputSchema: tool.inputSchema,
    },
    render: makeMcpRenderHooks(serverName, tool),
    isConcurrencySafe: tool.readOnlyHint === true,
    async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
      try {
        const result = await client.callTool(tool.name, call.input ?? {});
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
        return {
          tool_use_id: call.id,
          content: error instanceof Error ? error.message : String(error),
          is_error: true,
        };
      }
    },
  };
}

function mcpToolDescription(serverName: string, tool: McpToolInfo): string {
  return tool.description.length > 0
    ? `MCP server \`${serverName}\`: ${tool.description}`
    : `MCP tool \`${tool.name}\` from server \`${serverName}\`.`;
}

export function makeMcpRenderHooks(
  serverName: string,
  tool: Pick<McpToolInfo, "name" | "title" | "description">,
): ToolRenderHooks {
  return {
    userFacingName: () => `${serverName} - ${tool.name} (MCP)`,
    summarizeArgs: (input) => mcpArgsSummary(input),
    formatResult: (text) => text.replace(MCP_IMAGE_PLACEHOLDER_RE, "[Image]"),
  };
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
