import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, sep } from "node:path";
import { taskArtifactDirectory } from "@/engine/background/tasks/output-files.ts";
import { ephemeralSessionsRoot } from "@/engine/session/paths.ts";
import { formatFileSize } from "@/kernel/mcp/client/output/describe.ts";
import { canonicalizeCwd, isEphemeralCwd, projectPath } from "@/kernel/std/fs/paths.ts";
import type { ToolResultContentBlock } from "@/kernel/std/types/message.ts";
import {
  ARCHIVE_DIRECTORY_NAME,
  ARCHIVE_NOTICE_CLOSE,
  ARCHIVE_NOTICE_OPEN,
  ARCHIVE_PREVIEW_CHARACTER_LIMIT,
  ARCHIVED_OUTPUT_CHARACTER_LIMIT,
  INLINE_OUTPUT_CHARACTER_LIMIT,
} from "./contract.ts";

export interface ArchivedToolOutput {
  path: string;
  characterCount: number;
  structured: boolean;
  preview: string;
  truncated: boolean;
}

export interface ToolOutputArchiveError {
  error: string;
}

type ArchivableToolOutputBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | ToolResultContentBlock[];
  is_error?: boolean;
};

const FILESYSTEM_ERROR_TEXT: Readonly<Record<string, string | undefined>> = {
  ENOSPC: "No space left on device",
  EROFS: "Read-only file system",
  EMFILE: "Too many open files",
};

export function resolveToolOutputArchiveDirectory(): string {
  const override = process.env.OTHERSIDE_TOOL_RESULTS_DIR;
  if (override) return override;

  const taskDirectory = normalize(taskArtifactDirectory());
  return (
    sessionArchiveDirectory(taskDirectory) ?? join(taskDirectory, "..", ARCHIVE_DIRECTORY_NAME)
  );
}

function sessionArchiveDirectory(taskDirectory: string): string | null {
  const taskRoot = normalize(
    join(
      tmpdir(),
      `otherside-${typeof process.getuid === "function" ? String(process.getuid()) : "u"}`,
    ),
  );
  if (!taskDirectory.startsWith(taskRoot + sep)) return null;

  const segments = taskDirectory.slice(taskRoot.length + 1).split(sep);
  if (segments.length < 3 || segments.at(-1) !== "tasks") return null;
  const [projectSlug, sessionId] = segments;
  if (!projectSlug || !sessionId) return null;

  const cwd = process.cwd() ?? "";
  const archiveCwd = canonicalizeCwd(cwd);
  const projectDirectory = isEphemeralCwd(archiveCwd ?? "")
    ? join(ephemeralSessionsRoot(), projectSlug)
    : projectPath(cwd);
  return join(projectDirectory, sessionId, ARCHIVE_DIRECTORY_NAME);
}

export function resolveArchivedToolOutputPath(callId: string, structured: boolean): string {
  const extension = structured ? "json" : "txt";
  return join(resolveToolOutputArchiveDirectory(), `${callId}.${extension}`);
}

export async function prepareToolOutputArchive(): Promise<void> {
  try {
    await mkdir(resolveToolOutputArchiveDirectory(), { recursive: true });
  } catch {}
}

export function outputArchiveThreshold(toolName: string, requestedLimit?: number): number {
  if (toolName === "Read") return Number.POSITIVE_INFINITY;
  if (requestedLimit !== undefined && !Number.isFinite(requestedLimit)) return requestedLimit;
  return Math.min(requestedLimit ?? INLINE_OUTPUT_CHARACTER_LIMIT, INLINE_OUTPUT_CHARACTER_LIMIT);
}

export async function archiveToolOutput(
  content: string | ToolResultContentBlock[],
  callId: string,
): Promise<ArchivedToolOutput | ToolOutputArchiveError> {
  const structured = Array.isArray(content);
  if (structured && content.some((block) => block.type !== "text")) {
    return { error: "Cannot persist tool results containing non-text content" };
  }

  await prepareToolOutputArchive();
  const path = resolveArchivedToolOutputPath(callId, structured);
  const serialized = structured ? JSON.stringify(content, null, 2) : content;
  try {
    await writeFile(path, serialized, { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    if (filesystemErrorCode(error) !== "EEXIST") {
      return { error: filesystemErrorText(asError(error)) };
    }
  }

  const preview = buildArchivePreview(serialized, ARCHIVE_PREVIEW_CHARACTER_LIMIT);
  return {
    path,
    characterCount: serialized.length,
    structured,
    preview: preview.content,
    truncated: preview.truncated,
  };
}

export function isArchivedOutputNotice(content: string | ToolResultContentBlock[]): boolean {
  return typeof content === "string" && content.startsWith(ARCHIVE_NOTICE_OPEN);
}

export function formatArchivedOutputNotice(output: ArchivedToolOutput): string {
  const lines = [
    ARCHIVE_NOTICE_OPEN,
    `Output too large (${formatFileSize(output.characterCount)}). Full output saved to: ${output.path}`,
    "",
    `Preview (first ${formatFileSize(ARCHIVE_PREVIEW_CHARACTER_LIMIT)}):`,
    output.preview,
  ];
  if (output.truncated) lines.push("...");
  lines.push(ARCHIVE_NOTICE_CLOSE);
  return lines.join("\n");
}

export function isToolOutputEmpty(
  content: string | ToolResultContentBlock[] | undefined | null,
): boolean {
  if (!content) return true;
  if (typeof content === "string") return content.trim() === "";
  if (!Array.isArray(content)) return false;

  for (const block of content) {
    if (typeof block !== "object" || block === null || block.type !== "text") return false;
    if (!("text" in block)) return false;
    if (typeof block.text === "string" && block.text.trim() !== "") return false;
  }
  return true;
}

export function containsImageOutput(content: string | ToolResultContentBlock[]): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) => typeof block === "object" && block !== null && block.type === "image",
  );
}

export function toolOutputCharacterCount(content: string | ToolResultContentBlock[]): number {
  if (typeof content === "string") return content.length;
  let characters = 0;
  for (const block of content) {
    if (block.type === "text") characters += block.text.length;
  }
  return characters;
}

export async function archiveLargeToolOutput(
  block: ArchivableToolOutputBlock,
  toolName: string,
  threshold = ARCHIVED_OUTPUT_CHARACTER_LIMIT,
): Promise<ArchivableToolOutputBlock> {
  const content = block.content;
  if (isToolOutputEmpty(content)) {
    return { ...block, content: `(${toolName} completed with no output)` };
  }
  if (!content || containsImageOutput(content)) return block;
  if (toolOutputCharacterCount(content) <= threshold) return block;

  const archived = await archiveToolOutput(content, block.tool_use_id);
  if (isToolOutputArchiveError(archived)) return block;
  return { ...block, content: formatArchivedOutputNotice(archived) };
}

export function buildArchivePreview(
  content: string,
  characterLimit: number,
): { content: string; truncated: boolean } {
  const truncated = content.length > characterLimit;
  if (!truncated) return { content, truncated };

  const window = content.slice(0, characterLimit);
  const finalLineBreak = window.lastIndexOf("\n");
  const end = finalLineBreak > characterLimit / 2 ? finalLineBreak : characterLimit;
  return { content: content.slice(0, end), truncated };
}

export function isToolOutputArchiveError(
  output: ArchivedToolOutput | ToolOutputArchiveError,
): output is ToolOutputArchiveError {
  return "error" in output;
}

function filesystemErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function filesystemErrorText(error: Error): string {
  const nodeError = error as NodeJS.ErrnoException;
  const code = nodeError.code;
  if (!code) return error.message;

  const path = nodeError.path ?? "unknown path";
  if (code === "ENOENT") return `Directory not found: ${path}`;
  if (code === "EACCES") return `Permission denied: ${path}`;
  if (code === "EEXIST") return `File already exists: ${path}`;
  return FILESYSTEM_ERROR_TEXT[code] ?? `${code}: ${nodeError.message}`;
}
