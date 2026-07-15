import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, sep } from "node:path";
import { getTaskOutputDir } from "@/engine/background/tasks/output-files.ts";
import { ephemeralSessionsRoot } from "@/engine/session/paths.ts";
import { formatFileSize } from "@/kernel/mcp/client/output/describe.ts";
import { canonicalizeCwd, isEphemeralCwd, projectPath } from "@/kernel/std/fs/paths.ts";
import type { ToolResultContentBlock } from "@/kernel/std/types/message.ts";
import {
  DEFAULT_MAX_RESULT_SIZE_CHARS,
  MAX_TOOL_RESULT_BYTES,
  PERSISTED_OUTPUT_CLOSING_TAG,
  PERSISTED_OUTPUT_TAG,
  PREVIEW_SIZE_BYTES,
  TOOL_RESULTS_SUBDIR,
} from "./constants.ts";

export interface PersistedToolResult {
  filepath: string;
  originalSize: number;
  isJson: boolean;
  preview: string;
  hasMore: boolean;
}

export interface PersistToolResultError {
  error: string;
}

export function getToolResultsDir(): string {
  if (process.env.OTHERSIDE_TOOL_RESULTS_DIR) {
    return process.env.OTHERSIDE_TOOL_RESULTS_DIR;
  }
  const taskDir = normalize(getTaskOutputDir());
  const root = normalize(
    join(
      tmpdir(),
      `otherside-${typeof process.getuid === "function" ? String(process.getuid()) : "u"}`,
    ),
  );
  if (taskDir.startsWith(root + sep)) {
    const relativePath = taskDir.slice(root.length + 1);
    const parts = relativePath.split(sep);
    if (parts.length >= 3 && parts[parts.length - 1] === "tasks") {
      const slug = parts[0];
      const sessionId = parts[1];
      if (slug && sessionId) {
        const canonCwd = canonicalizeCwd(process.cwd() ?? "");
        const base = isEphemeralCwd(canonCwd ?? "")
          ? join(ephemeralSessionsRoot(), slug)
          : projectPath(process.cwd() ?? "");
        return join(base, sessionId, TOOL_RESULTS_SUBDIR);
      }
    }
  }
  return join(taskDir, "..", TOOL_RESULTS_SUBDIR);
}

export function getToolResultPath(id: string, isJson: boolean): string {
  const ext = isJson ? "json" : "txt";
  return join(getToolResultsDir(), `${id}.${ext}`);
}

export async function ensureToolResultsDir(): Promise<void> {
  try {
    await mkdir(getToolResultsDir(), { recursive: true });
  } catch {}
}

export function getPersistenceThreshold(
  toolName: string,
  declaredMaxResultSizeChars?: number,
): number {
  if (toolName === "Read") {
    return Number.POSITIVE_INFINITY;
  }
  if (declaredMaxResultSizeChars !== undefined && !Number.isFinite(declaredMaxResultSizeChars)) {
    return declaredMaxResultSizeChars;
  }
  return Math.min(
    declaredMaxResultSizeChars ?? DEFAULT_MAX_RESULT_SIZE_CHARS,
    DEFAULT_MAX_RESULT_SIZE_CHARS,
  );
}

export async function persistToolResult(
  content: string | ToolResultContentBlock[],
  toolUseId: string,
): Promise<PersistedToolResult | PersistToolResultError> {
  const isJson = Array.isArray(content);
  if (isJson) {
    const hasNonTextContent = content.some((block) => block.type !== "text");
    if (hasNonTextContent) {
      return {
        error: "Cannot persist tool results containing non-text content",
      };
    }
  }
  await ensureToolResultsDir();
  const filepath = getToolResultPath(toolUseId, isJson);
  const contentStr = isJson ? JSON.stringify(content, null, 2) : content;
  try {
    await writeFile(filepath, contentStr, { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    if (getErrnoCode(error) !== "EEXIST") {
      return { error: getFileSystemErrorMessage(toError(error)) };
    }
  }
  const { preview, hasMore } = generatePreview(contentStr, PREVIEW_SIZE_BYTES);
  return {
    filepath,
    originalSize: contentStr.length,
    isJson,
    preview,
    hasMore,
  };
}

export function isPersistedOutputWrapper(content: string | ToolResultContentBlock[]): boolean {
  return typeof content === "string" && content.startsWith(PERSISTED_OUTPUT_TAG);
}

export function buildLargeToolResultMessage(result: PersistedToolResult): string {
  let message = `${PERSISTED_OUTPUT_TAG}\n`;
  message += `Output too large (${formatFileSize(result.originalSize)}). Full output saved to: ${result.filepath}\n\n`;
  message += `Preview (first ${formatFileSize(PREVIEW_SIZE_BYTES)}):\n`;
  message += result.preview;
  message += result.hasMore ? "\n...\n" : "\n";
  message += PERSISTED_OUTPUT_CLOSING_TAG;
  return message;
}

export function isToolResultContentEmpty(
  content: string | ToolResultContentBlock[] | undefined | null,
): boolean {
  if (!content) return true;
  if (typeof content === "string") return content.trim() === "";
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return true;
  return content.every(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      block.type === "text" &&
      "text" in block &&
      (typeof block.text !== "string" || block.text.trim() === ""),
  );
}

export function hasImageBlock(content: string | ToolResultContentBlock[]): boolean {
  return (
    Array.isArray(content) &&
    content.some((b) => typeof b === "object" && b !== null && b.type === "image")
  );
}

export function contentSize(content: string | ToolResultContentBlock[]): number {
  if (typeof content === "string") return content.length;
  return content.reduce((sum, b) => sum + (b.type === "text" ? b.text.length : 0), 0);
}

export async function maybePersistLargeToolResult(
  toolResultBlock: {
    type: "tool_result";
    tool_use_id: string;
    content: string | ToolResultContentBlock[];
    is_error?: boolean;
  },
  toolName: string,
  persistenceThreshold?: number,
): Promise<{
  type: "tool_result";
  tool_use_id: string;
  content: string | ToolResultContentBlock[];
  is_error?: boolean;
}> {
  const content = toolResultBlock.content;
  if (isToolResultContentEmpty(content)) {
    return {
      ...toolResultBlock,
      content: `(${toolName} completed with no output)`,
    };
  }
  if (!content) {
    return toolResultBlock;
  }
  if (hasImageBlock(content)) {
    return toolResultBlock;
  }
  const size = contentSize(content);
  const threshold = persistenceThreshold ?? MAX_TOOL_RESULT_BYTES;
  if (size <= threshold) {
    return toolResultBlock;
  }
  const result = await persistToolResult(content, toolResultBlock.tool_use_id);
  if (isPersistError(result)) {
    return toolResultBlock;
  }
  const message = buildLargeToolResultMessage(result);
  return { ...toolResultBlock, content: message };
}

export function generatePreview(
  content: string,
  maxBytes: number,
): { preview: string; hasMore: boolean } {
  if (content.length <= maxBytes) {
    return { preview: content, hasMore: false };
  }
  const truncated = content.slice(0, maxBytes);
  const lastNewline = truncated.lastIndexOf("\n");
  const cutPoint = lastNewline > maxBytes * 0.5 ? lastNewline : maxBytes;
  return { preview: content.slice(0, cutPoint), hasMore: true };
}

export function isPersistError(
  result: PersistedToolResult | PersistToolResultError,
): result is PersistToolResultError {
  return "error" in result;
}

function getErrnoCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function getFileSystemErrorMessage(error: Error): string {
  const nodeError = error as NodeJS.ErrnoException;
  if (nodeError.code) {
    switch (nodeError.code) {
      case "ENOENT":
        return `Directory not found: ${nodeError.path ?? "unknown path"}`;
      case "EACCES":
        return `Permission denied: ${nodeError.path ?? "unknown path"}`;
      case "ENOSPC":
        return "No space left on device";
      case "EROFS":
        return "Read-only file system";
      case "EMFILE":
        return "Too many open files";
      case "EEXIST":
        return `File already exists: ${nodeError.path ?? "unknown path"}`;
      default:
        return `${nodeError.code}: ${nodeError.message}`;
    }
  }
  return error.message;
}
