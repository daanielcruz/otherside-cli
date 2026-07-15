import { recordPayloadDiagnostic } from "@/devtools/payload.ts";
import { marshalMcpContent } from "@/kernel/mcp/client/output/handler.ts";
import { loadEnabledMcpConfig } from "@/kernel/mcp/config.ts";
import type { McpClient, McpJsonConfig } from "@/kernel/mcp/protocol/types.ts";
import {
  parseWireToolName,
  sanitizeNamePart,
  wireToolName,
} from "@/kernel/mcp/protocol/wire-name.ts";
import type { ToolResult } from "@/kernel/std/types/message.ts";
import { clientFor } from "./registry.ts";

interface McpPersistContext {
  cwd: string;
  sessionId: string;
}

function findServer(
  cfg: McpJsonConfig,
  serverHint: string,
): [string, McpJsonConfig["mcpServers"][string]] | null {
  for (const [name, server] of Object.entries(cfg.mcpServers)) {
    if (sanitizeNamePart(name) === serverHint) return [name, server];
  }
  return null;
}

function err(toolUseId: string, message: string): ToolResult {
  return { tool_use_id: toolUseId, content: message, is_error: true };
}

async function resolveOriginalTool(
  client: McpClient,
  serverName: string,
  toolName: string,
): Promise<string | null> {
  const tools = await client.listTools();
  for (const tool of tools) {
    if (wireToolName(serverName, tool.name) === toolName) return tool.name;
  }
  return null;
}

export async function dispatchMcp(req: {
  toolUseId: string;
  toolName: string;
  args: unknown;
  persistCtx?: McpPersistContext;
}): Promise<ToolResult> {
  const { toolUseId, toolName, args, persistCtx } = req;
  const parsed = parseWireToolName(toolName);
  if (!parsed) return err(toolUseId, `not an MCP tool: ${toolName}`);
  const [serverHint] = parsed;

  let cfg: McpJsonConfig;
  try {
    cfg = await loadEnabledMcpConfig(process.cwd());
  } catch (e) {
    return err(toolUseId, e instanceof Error ? e.message : String(e));
  }

  const found = findServer(cfg, serverHint);
  if (!found) return err(toolUseId, `MCP server \`${serverHint}\` is not configured`);
  const [serverName, serverCfg] = found;

  try {
    const client = await clientFor(serverName, serverCfg);
    const originalTool = await resolveOriginalTool(client, serverName, toolName);
    if (!originalTool) return err(toolUseId, `MCP tool \`${toolName}\` not found on server`);
    const payloadContext = { serverName, toolName: originalTool, toolUseId };
    const result = await client.callTool(originalTool, args);
    recordPayloadDiagnostic("mcp-transport-result", result, payloadContext);
    const { content, isError } = marshalMcpContent(result, {
      cwd: persistCtx?.cwd ?? process.cwd(),
      sessionId: persistCtx?.sessionId ?? "session",
      ...payloadContext,
    });
    recordPayloadDiagnostic("mcp-returned-result", content, payloadContext);
    if (isError) return { tool_use_id: toolUseId, content, is_error: true };
    return { tool_use_id: toolUseId, content };
  } catch (e) {
    return err(toolUseId, e instanceof Error ? e.message : String(e));
  }
}
