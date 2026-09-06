import {
  parseDirectoryEntry,
  parseMcpPrompt,
  parseMcpResource,
  parseMcpTool,
} from "@/kernel/mcp/protocol/parse.ts";
import type {
  McpDirectoryListPage,
  McpPromptInfo,
  McpResourceInfo,
  McpToolInfo,
} from "@/kernel/mcp/protocol/types.ts";

type RpcSend = (method: string, params: unknown) => Promise<unknown>;

async function collectPaginated<T>(options: {
  send: RpcSend;
  method: string;
  field: string;
  parse: (item: unknown) => T | null;
}): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  while (true) {
    const params: Record<string, unknown> = cursor ? { cursor } : {};
    const result = (await options.send(options.method, params)) as Record<string, unknown> | null;
    const items = Array.isArray(result?.[options.field])
      ? (result[options.field] as unknown[])
      : [];
    for (const item of items) {
      const parsed = options.parse(item);
      if (parsed) out.push(parsed);
    }
    const next = typeof result?.nextCursor === "string" ? result.nextCursor : null;
    if (!next) break;
    cursor = next;
  }
  return out;
}

export async function listToolsVia(send: RpcSend): Promise<McpToolInfo[]> {
  return collectPaginated({ send, method: "tools/list", field: "tools", parse: parseMcpTool });
}

export async function listResourcesVia(send: RpcSend): Promise<McpResourceInfo[]> {
  return collectPaginated({
    send,
    method: "resources/list",
    field: "resources",
    parse: parseMcpResource,
  });
}

export async function listPromptsVia(send: RpcSend): Promise<McpPromptInfo[]> {
  return collectPaginated({
    send,
    method: "prompts/list",
    field: "prompts",
    parse: parseMcpPrompt,
  });
}

export async function getPromptVia(
  send: RpcSend,
  options: { name: string; args: Record<string, string> },
): Promise<unknown> {
  return send("prompts/get", { name: options.name, arguments: options.args });
}

export async function callToolVia(
  send: RpcSend,
  options: { name: string; args: unknown },
): Promise<unknown> {
  return send("tools/call", { name: options.name, arguments: options.args ?? {} });
}

export async function readResourceVia(send: RpcSend, uri: string): Promise<unknown> {
  return send("resources/read", { uri });
}

/** One page of `resources/directory/read` (caller owns pagination + InvalidParams policy). */
export async function listDirectoryPageVia(
  send: RpcSend,
  uri: string,
  cursor?: string,
): Promise<McpDirectoryListPage> {
  const params: Record<string, unknown> = { uri };
  if (cursor) params.cursor = cursor;
  const result = (await send("resources/directory/read", params)) as Record<string, unknown> | null;
  if (result === null || !Array.isArray(result.resources)) {
    throw new Error("Invalid resources/directory/read result: `resources` must be an array");
  }
  const resources = [];
  for (const item of result.resources) {
    const parsed = parseDirectoryEntry(item);
    if (parsed === null) {
      throw new Error(
        "Invalid resources/directory/read result: every resource requires string `uri` and `name`",
      );
    }
    resources.push(parsed);
  }
  if (result.nextCursor !== undefined && typeof result.nextCursor !== "string") {
    throw new Error("Invalid resources/directory/read result: `nextCursor` must be a string");
  }
  return typeof result.nextCursor === "string"
    ? { resources, nextCursor: result.nextCursor }
    : { resources };
}
