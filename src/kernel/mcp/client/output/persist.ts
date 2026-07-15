import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordPayloadDiagnostic } from "@/devtools/payload.ts";
import {
  contentContainsImages,
  extensionForMimeType,
  stringifyJson,
  textBlock,
} from "@/kernel/mcp/client/output/blocks.ts";
import {
  formatDescription,
  formatFileSize,
  type LineMeta,
  lineMetaFor,
} from "@/kernel/mcp/client/output/describe.ts";
import type { McpOutputContext, TransformedMcpResult } from "@/kernel/mcp/client/output/handler.ts";
import { sanitizeNamePart } from "@/kernel/mcp/protocol/wire-name.ts";
import { errorMessage } from "@/kernel/std/errno.ts";
import {
  canonicalizeCwd,
  isEphemeralCwd,
  MAX_PERSISTED_TOOL_OUTPUT_BYTES,
  projectPath,
  projectSlug,
} from "@/kernel/std/fs/paths.ts";
import { capUtf8ToBytes } from "@/kernel/std/text/text.ts";
import type { ToolResultContentBlock } from "@/kernel/std/types/message.ts";

const DEFAULT_MAX_OUTPUT_TOKENS = 25_000;
const BYTES_PER_TOKEN = 4;
const IMAGE_TOKEN_ESTIMATE = 1_600;
const FILE_READING_TOKEN_BUDGET = 25_000;
const SUBAGENT_CONTEXT_RATIO = 0.8;
const LINE_NUMBERING_BUDGET = 8;
let outputSerial = 0;

export function handleLargeMcpContent(
  result: TransformedMcpResult,
  context: McpOutputContext,
): string | ToolResultContentBlock[] {
  if (!mcpContentNeedsHandling(result.content)) return result.content;
  if (isLargeOutputFilesDisabled()) return truncateMcpContent(result.content);
  if (contentContainsImages(result.content)) return truncateMcpContent(result.content);
  const persisted = persistLargeMcpContent(result, context);
  if (persisted === null) return truncateMcpContent(result.content);
  return largeOutputInstructions({
    filePath: persisted.filePath,
    contentLength: persisted.contentLength,
    formatDescription: persisted.formatDescription,
    ...(persisted.lineMeta ? { lineMeta: persisted.lineMeta } : {}),
  });
}

function persistLargeMcpContent(
  result: TransformedMcpResult,
  context: McpOutputContext,
): {
  filePath: string;
  contentLength: number;
  formatDescription: string;
  lineMeta?: LineMeta;
} | null {
  const persistedContent = persistedContentFor(result);
  const id = `mcp-${sanitizeNamePart(context.serverName)}-${sanitizeNamePart(context.toolName)}-${Date.now()}`;
  const filePath = writeTextOutput({ content: persistedContent.content, context, id });
  if (!filePath) return null;
  return {
    filePath,
    contentLength: persistedContent.content.length,
    formatDescription: persistedContent.formatDescription,
    ...(persistedContent.lineMeta ? { lineMeta: persistedContent.lineMeta } : {}),
  };
}

function persistedContentFor(result: TransformedMcpResult): {
  content: string;
  formatDescription: string;
  lineMeta?: LineMeta;
} {
  const content = result.content;
  if (typeof content === "string") {
    const lineMeta = lineMetaFor(content);
    return {
      content,
      formatDescription: formatDescription(result),
      ...(lineMeta ? { lineMeta } : {}),
    };
  }
  const first = content[0];
  if (content.length === 1 && first?.type === "text") {
    const lineMeta = lineMetaFor(first.text);
    return {
      content: first.text,
      formatDescription: "Plain text",
      ...(lineMeta ? { lineMeta } : {}),
    };
  }
  return { content: stringifyJson(content), formatDescription: formatDescription(result) };
}

function writeTextOutput(options: {
  content: string;
  context: McpOutputContext;
  id: string;
}): string | null {
  const filePath = outputPath(options.context, options.id, "txt");
  const payloadContext = {
    serverName: options.context.serverName,
    toolName: options.context.toolName,
    toolUseId: options.context.toolUseId,
  };
  try {
    mkdirSync(outputDir(options.context), { recursive: true });
    recordPayloadDiagnostic("mcp-persist-source", undefined, payloadContext, {
      payloadChars: options.content.length,
    });
    const capped = capUtf8ToBytes(options.content, MAX_PERSISTED_TOOL_OUTPUT_BYTES);
    recordPayloadDiagnostic("mcp-persist-capped", undefined, payloadContext, {
      ...(typeof capped === "string" ? { payloadChars: capped.length } : {}),
      payloadBytes: typeof capped === "string" ? Buffer.byteLength(capped, "utf8") : capped.length,
    });
    writeFileSync(filePath, capped, { flag: "wx" });
    return filePath;
  } catch {
    return null;
  }
}

export function persistBinaryBlock(
  data: string,
  mimeTypeValue: unknown,
  sourceDescription: string,
  context: McpOutputContext,
): ToolResultContentBlock {
  const buffer = Buffer.from(data, "base64");
  const mimeType = typeof mimeTypeValue === "string" ? mimeTypeValue : undefined;
  const id = `mcp-${sanitizeNamePart(context.serverName)}-blob-${Date.now()}-${outputSerial}`;
  outputSerial += 1;
  const ext = extensionForMimeType(mimeType);
  const filePath = outputPath(context, id, ext);
  try {
    mkdirSync(outputDir(context), { recursive: true });
    writeFileSync(filePath, buffer);
    return textBlock(
      `${sourceDescription}Binary content (${mimeType ?? "unknown type"}, ${formatFileSize(buffer.length)}) saved to ${filePath}`,
    );
  } catch (error) {
    const message = errorMessage(error);
    return textBlock(
      `${sourceDescription}Binary content (${mimeType ?? "unknown type"}, ${buffer.length} bytes) could not be saved to disk: ${message}`,
    );
  }
}

function outputPath(context: McpOutputContext, id: string, ext: string): string {
  return join(outputDir(context), `${id}.${ext}`);
}

function outputDir(context: McpOutputContext): string {
  if (process.env.OTHERSIDE_TOOL_RESULTS_DIR) return process.env.OTHERSIDE_TOOL_RESULTS_DIR;
  const canonCwd = canonicalizeCwd(context.cwd);
  const base = isEphemeralCwd(canonCwd)
    ? join(tmpdir(), "otherside-sessions", projectSlug(canonCwd))
    : projectPath(canonCwd);
  return join(base, context.sessionId, "tool-results");
}

function mcpContentNeedsHandling(content: string | ToolResultContentBlock[]): boolean {
  return contentSizeEstimate(content) > maxMcpOutputTokens();
}

function contentSizeEstimate(content: string | ToolResultContentBlock[]): number {
  if (typeof content === "string") return Math.round(content.length / BYTES_PER_TOKEN);
  return content.reduce((total, block) => {
    if (block.type === "text") return total + Math.round(block.text.length / BYTES_PER_TOKEN);
    if (block.type === "image") return total + IMAGE_TOKEN_ESTIMATE;
    return total;
  }, 0);
}

function maxMcpOutputTokens(): number {
  const raw = process.env.MAX_MCP_OUTPUT_TOKENS;
  if (!raw) return DEFAULT_MAX_OUTPUT_TOKENS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_OUTPUT_TOKENS;
}

function isLargeOutputFilesDisabled(): boolean {
  const raw = process.env.ENABLE_MCP_LARGE_OUTPUT_FILES;
  if (raw === undefined) return false;
  return ["0", "false", "no", "off"].includes(raw.toLowerCase());
}

function truncateMcpContent(
  content: string | ToolResultContentBlock[],
): string | ToolResultContentBlock[] {
  const maxChars = maxMcpOutputTokens() * BYTES_PER_TOKEN;
  const message = truncationMessage();
  if (typeof content === "string") return `${content.slice(0, maxChars)}${message}`;
  const blocks: ToolResultContentBlock[] = [];
  let usedChars = 0;
  for (const block of content) {
    if (block.type === "text") {
      const remaining = maxChars - usedChars;
      if (remaining <= 0) break;
      if (block.text.length <= remaining) {
        blocks.push(block);
        usedChars += block.text.length;
      } else {
        blocks.push({ type: "text", text: block.text.slice(0, remaining) });
        break;
      }
    } else if (block.type === "image") {
      const imageChars = IMAGE_TOKEN_ESTIMATE * BYTES_PER_TOKEN;
      if (usedChars + imageChars <= maxChars) {
        blocks.push(block);
        usedChars += imageChars;
      }
    }
  }
  blocks.push({ type: "text", text: message });
  return blocks;
}

function truncationMessage(): string {
  return `\n\n[OUTPUT TRUNCATED - exceeded ${maxMcpOutputTokens()} token limit]\n\nThe tool output was truncated. If this MCP server provides pagination or filtering tools, use them to retrieve specific portions of the data. If pagination is not available, inform the user that you are working with truncated output and results may be incomplete.`;
}

function largeOutputInstructions(options: {
  filePath: string;
  contentLength: number;
  formatDescription: string;
  lineMeta?: LineMeta;
}): string {
  const sizeDescription = options.lineMeta
    ? `${options.contentLength.toLocaleString()} characters across ${options.lineMeta.count.toLocaleString()} ${options.lineMeta.count === 1 ? "line" : "lines"}`
    : `${options.contentLength.toLocaleString()} characters`;
  const header = `Error: result (${sizeDescription}) exceeds maximum allowed tokens. Output has been saved to ${options.filePath}.\nFormat: ${options.formatDescription}\n`;
  if (!isSubagentPromptEnabled()) {
    return `${header}Use offset and limit parameters to read specific portions of the file, search within it for specific content, and jq to make structured queries.\nREQUIREMENTS FOR SUMMARIZATION/ANALYSIS/REVIEW:\n- You MUST read the content from the file at ${options.filePath} in sequential chunks until 100% of the content has been read.\n- If you receive truncation warnings when reading the file, reduce the chunk size until you have read 100% of the content without truncation.\n- Before producing ANY summary or analysis, you MUST explicitly describe what portion of the content you have read. ***If you did not read the entire content, you MUST explicitly state this.***\n`;
  }
  return `${header}${subagentOutputInstructions(options)}`;
}

function subagentOutputInstructions(options: {
  filePath: string;
  contentLength: number;
  lineMeta?: LineMeta;
}): string {
  const budget = Math.floor(FILE_READING_TOKEN_BUDGET * BYTES_PER_TOKEN * SUBAGENT_CONTEXT_RATIO);
  if (!options.lineMeta) {
    return `- For targeted queries (find a value, filter by field): use jq on the file directly.\n- For analysis or summarization that requires reading the full content: first probe the structure (e.g., jq 'type, length, keys?' ${options.filePath}), then extract slices with jq or python — Read's line-based offset/limit will not chunk this file.\n- If the Agent tool is available, do this inside a subagent so the full output stays out of your main context. Give it the instruction above verbatim, and be explicit about what it must return — e.g. "${options.filePath} is JSON; probe the structure with jq (type/length/keys), then extract and read the content in full with jq or python, then summarize and quote any key findings verbatim." A vague "summarize this" may lose detail.\n`;
  }
  if (options.lineMeta.maxLen > budget) {
    const sliceWidth = budget.toLocaleString();
    return `- For targeted searches (find a string): use grep on the file directly.\n- For analysis or summarization that requires reading the full content: the file's lines are too long for Read's offset/limit. Slice by character range via Bash instead — e.g. python3 -c "print(open('${options.filePath}').read()[A:B])" in ~${sliceWidth}-char spans until you have read 100% of it.\n- If the Agent tool is available, do this inside a subagent so the full output stays out of your main context. Give it the instruction above verbatim, and be explicit about what it must return — e.g. "Slice ${options.filePath} in ~${sliceWidth}-char spans via python (read()[A:B]) until you have read all ${options.contentLength.toLocaleString()} characters, then summarize and quote any key findings verbatim." A vague "summarize this" may lose detail.\n`;
  }
  const linesPerChunk = Math.max(
    1,
    Math.floor(budget / (options.lineMeta.maxLen + LINE_NUMBERING_BUDGET)),
  );
  return `- For targeted searches (find a line, locate a string): use grep on the file directly.\n- For analysis or summarization that requires reading the full content: read ${options.filePath} in chunks of ~${linesPerChunk} lines using offset/limit until you have read 100% of it.\n- If the Agent tool is available, do this inside a subagent so the full output stays out of your main context. Give it the instruction above verbatim, and be explicit about what it must return — e.g. "Read ${options.filePath} in chunks of ~${linesPerChunk} lines using offset/limit until you have read all ${options.lineMeta.count.toLocaleString()} lines, then summarize and quote any key findings verbatim." A vague "summarize this" may lose detail.\n`;
}

function isSubagentPromptEnabled(): boolean {
  const raw = process.env.MCP_TRUNCATION_PROMPT_OVERRIDE;
  return raw !== undefined && raw !== "legacy";
}
