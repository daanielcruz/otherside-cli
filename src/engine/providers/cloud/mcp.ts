import type { ContentBlock, ToolResultContentBlock } from "@/kernel/std/types/message.ts";
import { record, string } from "./client.ts";

export const MCP_SERVER_NAME = "otherside";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
export const CLOUD_CONNECT_TOOL_NAME = "OthersideLocalConnect";
export const CLOUD_BOUNDARY_HOOK_ID = "otherside_local_boundary";
// The local harness owns tool limits and permission waits; the worker must not abandon a call first.
export const CLOUD_LOCAL_TOOL_TIMEOUT_MS = 2_147_483_647;
export const CLOUD_LOCAL_TOOL_BACKGROUND_ENV = "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS";

export function verifyLocalToolWait(settings: Record<string, unknown>): void {
  const effective = record(
    settings.effective,
    "get_settings.effective for local tool auto-background",
  );
  const env = record(effective.env, "get_settings.effective.env for local tool auto-background");
  if (env[CLOUD_LOCAL_TOOL_BACKGROUND_ENV] !== "0") {
    throw new Error(
      `Cloud did not disable local tool auto-background: expected get_settings.effective.env.${CLOUD_LOCAL_TOOL_BACKGROUND_ENV} to be "0"`,
    );
  }
}

export const CLOUD_CONNECT_TOOL: CloudTool = {
  name: CLOUD_CONNECT_TOOL_NAME,
  description: "Confirm the local Otherside SDK connection. Used only during initialization.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export function isRegisteredCloudTool(name: unknown, tools: readonly CloudTool[]): boolean {
  return tools.some((tool) => name === `${MCP_TOOL_PREFIX}${tool.name}`);
}

export function denyCloudHook(
  name?: unknown,
  tools: readonly CloudTool[] = [],
): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Only registered local Otherside SDK callbacks are permitted.${localToolHint(name, tools)}`,
    },
  };
}

function localToolHint(name: unknown, tools: readonly CloudTool[]): string {
  const local = tools.find((tool) => tool.name === name);
  return local ? ` Use ${MCP_TOOL_PREFIX}${local.name} instead.` : "";
}

export function nativeDenyUpdate(names: ReadonlySet<string>): Record<string, unknown>[] {
  if (names.size === 0) throw new Error("Cloud bootstrap has no native tool inventory");
  return [
    {
      type: "addRules",
      destination: "session",
      behavior: "deny",
      rules: [...names].map((toolName) => ({ toolName })),
    },
  ];
}

export function normalizeNativeToolName(name: string): string {
  // The worker canonicalizes its Task inventory entry when it stores an Agent rule.
  return name === "Task" ? "Agent" : name;
}

export function verifyNativeDenies(
  response: Record<string, unknown>,
  names: ReadonlySet<string>,
): void {
  const state = record(response.state, "permission state");
  if (state.managedOnly !== false || !Array.isArray(state.rules) || names.size === 0) {
    throw new Error(
      "Cloud native-tool isolation could not be confirmed from session permission rules",
    );
  }
  const denied = new Set<string>();
  for (const value of state.rules) {
    const rule = record(value, "permission rule");
    if (
      rule.behavior === "deny" &&
      rule.source === "session" &&
      !rule.notInEffect &&
      typeof rule.rule === "string"
    ) {
      denied.add(rule.rule);
    }
  }
  const missing = [...names].filter((name) => !denied.has(normalizeNativeToolName(name)));
  if (missing.length > 0) {
    throw new Error(
      `Cloud native-tool isolation is missing effective session denies: ${missing.join(", ")}`,
    );
  }
}

export interface CloudTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface PendingToolCall {
  requestId: string;
  rpcId: string | number;
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

export function cloudTools(tools: unknown[]): CloudTool[] {
  const names = new Set<string>();
  return tools.map((value) => {
    const tool = record(value, "tool definition");
    const name = string(tool.name, "tool name");
    if (names.has(name)) throw new Error(`Cloud duplicate local tool: ${name}`);
    names.add(name);
    return {
      name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: record(tool.input_schema ?? tool.inputSchema, `input schema for ${name}`),
    };
  });
}

export function localToolName(name: string, tools: readonly CloudTool[]): string | undefined {
  // An actual registered name wins, including names belonging to a local MCP server.
  if (tools.some((tool) => tool.name === name)) return name;
  const registered = tools.find((tool) => `${MCP_TOOL_PREFIX}${tool.name}` === name);
  return registered?.name;
}

export function cloudPermissionResponse(
  request: Record<string, unknown>,
  tools: readonly CloudTool[],
): Record<string, unknown> {
  const name = typeof request.tool_name === "string" ? request.tool_name : "";
  const registered = tools.some((tool) => `${MCP_TOOL_PREFIX}${tool.name}` === name);
  if (registered) {
    // This authorizes only delivery to the SDK callback, never local execution.
    return { behavior: "allow", updatedInput: record(request.input, "tool permission input") };
  }
  return {
    behavior: "deny",
    message: `Only registered Otherside SDK tools are permitted${localToolHint(name, tools)}`,
  };
}

export function parseToolCall(
  payload: Record<string, unknown>,
  tools: readonly CloudTool[],
): PendingToolCall {
  const request = record(payload.request, "MCP control request");
  if (request.server_name !== MCP_SERVER_NAME)
    throw new Error("Cloud requested a foreign MCP server");
  const rpc = record(request.message, "MCP request message");
  const params = record(rpc.params, "tools/call params");
  const wireName = string(params.name, "tools/call name");
  const name = localToolName(wireName, tools);
  if (!name) throw new Error(`Cloud requested an unregistered local tool: ${wireName}`);
  const meta = record(params._meta, "tools/call _meta");
  return {
    requestId: string(payload.request_id, "control request_id"),
    rpcId: rpcId(rpc.id),
    toolUseId: string(meta["claudecode/toolUseId"], "claudecode/toolUseId"),
    name,
    input: record(params.arguments, "tools/call arguments"),
  };
}

export function cancelledMcpRequestId(rpc: Record<string, unknown>): string | number | undefined {
  if (rpc.method !== "notifications/cancelled") return undefined;
  return rpcId(record(rpc.params, "MCP cancellation params").requestId);
}

export function isBackgroundedMcpResult(content: unknown, toolName: string): boolean {
  const texts = typeof content === "string" ? [content] : [];
  if (Array.isArray(content)) {
    for (const value of content) {
      const block = record(value, "MCP result content");
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
  }
  const prefix = `MCP tool "${MCP_SERVER_NAME}/${toolName}" is still running after `;
  return texts.some(
    (text) =>
      text.startsWith(prefix) &&
      /^\d+s\. It was moved to the background as task /.test(text.slice(prefix.length)),
  );
}

export function mcpHandshake(
  rpc: Record<string, unknown>,
  tools: readonly CloudTool[],
): Record<string, unknown> | undefined {
  if (rpc.method === "initialize") {
    const params = record(rpc.params, "MCP initialize params");
    return {
      jsonrpc: "2.0",
      id: rpcId(rpc.id),
      result: {
        protocolVersion: string(params.protocolVersion, "MCP protocolVersion"),
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: MCP_SERVER_NAME, version: "1.0.0" },
      },
    };
  }
  if (rpc.method === "notifications/initialized") return { jsonrpc: "2.0", id: 0, result: {} };
  if (rpc.method === "tools/list") {
    // The local harness already selected this roster; do not defer it behind native ToolSearch.
    const published = tools.map((tool) => ({ ...tool, _meta: { "anthropic/alwaysLoad": true } }));
    return { jsonrpc: "2.0", id: rpcId(rpc.id), result: { tools: published } };
  }
  if (rpc.method === "tools/call") return undefined;
  return {
    jsonrpc: "2.0",
    id: rpc.id === undefined ? 0 : rpcId(rpc.id),
    error: { code: -32601, message: "MCP method not supported" },
  };
}

function rpcId(value: unknown): string | number {
  if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value)))
    return value;
  throw new Error("Cloud protocol: invalid MCP request id");
}

export function mcpToolResult(
  call: PendingToolCall,
  result: Extract<ContentBlock, { type: "tool_result" }>,
): Record<string, unknown> {
  const content =
    typeof result.content === "string"
      ? [{ type: "text", text: result.content }]
      : result.content.map(mcpContent);
  return { jsonrpc: "2.0", id: call.rpcId, result: { content, isError: result.is_error === true } };
}

function mcpContent(block: ToolResultContentBlock): Record<string, unknown> {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "image") {
    return { type: "image", data: block.source.data, mimeType: block.source.media_type };
  }
  if (block.type === "tool_reference") {
    // The updated registry, not this textual reference, exposes the tool on the next round.
    return { type: "text", text: block.tool_name };
  }
  throw new Error("Cloud SDK tool results do not support PDF blocks; provide page images instead");
}
