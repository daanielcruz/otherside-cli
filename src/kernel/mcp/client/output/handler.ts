import {
  ensureNonEmptyContent,
  field,
  hasField,
  imageBlock,
  isImageMimeType,
  stringifyInline,
  stringifyJson,
  textBlock,
} from "@/kernel/mcp/client/output/blocks.ts";
import { inferCompactSchema } from "@/kernel/mcp/client/output/describe.ts";
import { handleLargeMcpContent, persistBinaryBlock } from "@/kernel/mcp/client/output/persist.ts";
import type { ToolResultContentBlock } from "@/kernel/std/types/message.ts";

export interface McpOutputContext {
  cwd: string;
  sessionId: string;
  serverName: string;
  toolName: string;
  toolUseId: string;
}

export interface MarshaledMcpContent {
  content: string | ToolResultContentBlock[];
  isError: boolean;
}

type McpResultType = "toolResult" | "structuredContent" | "contentArray";

export interface TransformedMcpResult {
  content: string | ToolResultContentBlock[];
  type: McpResultType;
  schema?: string;
}

export function marshalMcpContent(result: unknown, context: McpOutputContext): MarshaledMcpContent {
  const transformed = transformMcpResult(result, context);
  const content = handleLargeMcpContent(transformed, context);
  const isError = field(result, "isError") === true;
  return { content: ensureNonEmptyContent(content, context.toolName), isError };
}

function transformMcpResult(result: unknown, context: McpOutputContext): TransformedMcpResult {
  if (hasField(result, "toolResult")) {
    return { content: String(field(result, "toolResult")), type: "toolResult" };
  }
  const structuredContent = field(result, "structuredContent");
  if (structuredContent !== undefined) {
    return {
      content: stringifyJson(structuredContent),
      type: "structuredContent",
      schema: inferCompactSchema(structuredContent),
    };
  }
  const content = field(result, "content");
  if (Array.isArray(content)) {
    const blocks = content.flatMap((part) => transformResultPart(part, context));
    return {
      content: blocks,
      type: "contentArray",
      schema: inferCompactSchema(blocks),
    };
  }
  return { content: stringifyJson(result ?? null), type: "toolResult" };
}

function transformResultPart(part: unknown, context: McpOutputContext): ToolResultContentBlock[] {
  const type = field(part, "type");
  if (type === "text") {
    const text = field(part, "text");
    return [{ type: "text", text: typeof text === "string" ? text : "" }];
  }
  if (type === "image") {
    const data = field(part, "data");
    if (typeof data !== "string") return [textBlock(stringifyJson(part))];
    return [imageBlock(data, field(part, "mimeType"))];
  }
  if (type === "audio") {
    const data = field(part, "data");
    if (typeof data !== "string") return [textBlock(stringifyJson(part))];
    return [
      persistBinaryBlock(
        data,
        field(part, "mimeType"),
        `[Audio from ${context.serverName}] `,
        context,
      ),
    ];
  }
  if (type === "resource") {
    return transformResourcePart(part, context);
  }
  if (type === "resource_link") {
    const name = field(part, "name");
    const uri = field(part, "uri");
    const description = field(part, "description");
    const suffix =
      typeof description === "string" && description.length > 0 ? ` (${description})` : "";
    return [textBlock(`[Resource link: ${String(name)}] ${String(uri)}${suffix}`)];
  }
  return [textBlock(stringifyInline(part))];
}

function transformResourcePart(part: unknown, context: McpOutputContext): ToolResultContentBlock[] {
  const resource = field(part, "resource");
  const uri = field(resource, "uri");
  const mimeType = field(resource, "mimeType");
  const prefix = `[Resource from ${context.serverName} at ${String(uri)}] `;
  const text = field(resource, "text");
  if (typeof text === "string") return [textBlock(`${prefix}${text}`)];
  const blob = field(resource, "blob");
  if (typeof blob !== "string") return [];
  if (isImageMimeType(mimeType)) return [imageBlock(blob, mimeType)];
  return [persistBinaryBlock(blob, mimeType, prefix, context)];
}
