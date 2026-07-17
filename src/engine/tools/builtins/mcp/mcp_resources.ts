import type { ToolHandler } from "@/engine/tools/contract.ts";
import ListMcpResourcesSchema from "@/harness/tools/ListMcpResources/tool.json" with {
  type: "json",
};
import ReadMcpResourceSchema from "@/harness/tools/ReadMcpResource/tool.json" with { type: "json" };
import ReadMcpResourceDirSchema from "@/harness/tools/ReadMcpResourceDirTool/tool.json" with {
  type: "json",
};
import {
  boundMcpResourceOutput,
  listMcpResources,
  MAX_MCP_RESOURCE_OUTPUT_CHARS,
  readMcpDirectory,
  readMcpResource,
} from "@/kernel/mcp/index.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

interface ListInput {
  server?: unknown;
}

interface ReadInput {
  server?: unknown;
  uri?: unknown;
}

function err(toolUseId: string, message: string): ToolResult {
  return { tool_use_id: toolUseId, content: message, is_error: true };
}

function ok(toolUseId: string, payload: unknown): ToolResult {
  return { tool_use_id: toolUseId, content: boundMcpResourceOutput(payload) };
}

function okText(toolUseId: string, content: string): ToolResult {
  const bounded =
    content.length <= MAX_MCP_RESOURCE_OUTPUT_CHARS
      ? content
      : `${content.slice(0, MAX_MCP_RESOURCE_OUTPUT_CHARS)}\n...[truncated]`;
  return { tool_use_id: toolUseId, content: bounded };
}

export const ListMcpResourcesTool: ToolHandler = {
  schema: {
    name: ListMcpResourcesSchema.name,
    description: ListMcpResourcesSchema.description,
    inputSchema: ListMcpResourcesSchema.inputSchema,
  },
  isConcurrencySafe: true,
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as ListInput;
    const server = typeof args.server === "string" ? args.server : undefined;
    const resources = await listMcpResources({
      cwd: ctx.cwd,
      ...(server ? { server } : {}),
    });
    return ok(call.id, { resources });
  },
};

export const ReadMcpResourceTool: ToolHandler = {
  schema: {
    name: ReadMcpResourceSchema.name,
    description: ReadMcpResourceSchema.description,
    inputSchema: ReadMcpResourceSchema.inputSchema,
  },
  isConcurrencySafe: true,
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as ReadInput;
    const server = typeof args.server === "string" ? args.server : null;
    const uri = typeof args.uri === "string" ? args.uri : null;
    if (!server) return err(call.id, "`server` is required");
    if (!uri) return err(call.id, "`uri` is required");
    const result = await readMcpResource({ cwd: ctx.cwd, server, uri });
    if (result.kind === "unknown-server") {
      return err(
        call.id,
        `server "${server}" not found. Available servers: ${result.available.join(", ")}`,
      );
    }
    if (result.kind === "error") return err(call.id, result.message);
    return ok(call.id, { contents: result.contents });
  },
};

export const ReadMcpResourceDirTool: ToolHandler = {
  schema: {
    name: ReadMcpResourceDirSchema.name,
    description: ReadMcpResourceDirSchema.description,
    inputSchema: ReadMcpResourceDirSchema.inputSchema,
  },
  isConcurrencySafe: true,
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as ReadInput;
    const server = typeof args.server === "string" ? args.server : null;
    const uri = typeof args.uri === "string" ? args.uri : null;
    if (!server) return err(call.id, "`server` is required");
    if (!uri) return err(call.id, "`uri` is required");

    const result = await readMcpDirectory({ cwd: ctx.cwd, server, uri });
    if (result.kind === "controlled-error") return okText(call.id, result.message);

    const names = result.resources.map(
      (resource) => `${resource.name}${resource.mimeType === "inode/directory" ? "/" : ""}`,
    );
    const summary =
      names.length > 0
        ? `Directory listing (${names.length} ${names.length === 1 ? "entry" : "entries"}):\n${names.join("\n")}`
        : "Directory is empty.";
    return okText(call.id, `${summary}\n\n${JSON.stringify({ resources: result.resources })}`);
  },
};
