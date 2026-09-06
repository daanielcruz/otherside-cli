import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { isTaskOutputPath, taskIdFromOutputPath } from "@/engine/background/tasks/output-files.ts";
import { canSendNatively } from "@/engine/model/facts/capabilities-runtime.ts";
import { readNotebookBlocks } from "@/engine/tools/_infra/notebook-read.ts";
import {
  isNetworkSharePath,
  NETWORK_SHARE_PATH_ERROR,
} from "@/engine/tools/builtins/path-guards.ts";
import type { ToolArgSegment, ToolHandler } from "@/engine/tools/contract.ts";
import { filePathSegment } from "@/engine/tools/contract.ts";
import ReadSchema from "@/harness/tools/Read/tool.json" with { type: "json" };
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { readImageBranch, readPdfBranch } from "./read-media.ts";
import { readScopeKey, readSetInsert, readState } from "./state.ts";

export function getReadToolDescription(opts: { lean?: boolean } = {}): string {
  return opts.lean ? ReadSchema.description.lean : ReadSchema.description.full;
}

const DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_FILE_SIZE = 256 * 1024;
const MAX_OUTPUT_TOKENS = 25000;
const FILE_UNCHANGED_STUB =
  "File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.";

function bytesPerTokenForExt(ext: string): number {
  return ext === "json" || ext === "jsonl" || ext === "jsonc" ? 2 : 4;
}

function roughTokenCount(content: string, ext: string): number {
  return Math.round(content.length / bytesPerTokenForExt(ext));
}

function tokenCapError(toolUseId: string, tokenCount: number): ToolResult {
  return err(
    toolUseId,
    `File content (${tokenCount} tokens) exceeds maximum allowed tokens (${MAX_OUTPUT_TOKENS}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
  );
}

const STDIO_DEVICE_DENYLIST = new Set([
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/tty",
  "/dev/console",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/full",
  "/proc/self/fd/0",
  "/proc/self/fd/1",
  "/proc/self/fd/2",
]);

const BLOCKED_EXTENSIONS = new Set([
  "exe",
  "dll",
  "so",
  "dylib",
  "a",
  "lib",
  "o",
  "bin",
  "dat",
  "class",
  "jar",
  "war",
  "pyc",
  "pyo",
  "pyd",
  "zip",
  "tar",
  "gz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "zst",
  "mp3",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "wav",
  "flac",
  "ogg",
  "webm",
  "wasm",
]);

function isHallucinatedTaskOutputPath(p: string): boolean {
  if (isTaskOutputPath(p)) return false;
  return p.includes(".otherside/tasks/") || p.includes("/otherside/tasks/");
}

function findSimilarFile(filePath: string): string | null {
  const dir = dirname(filePath);
  const target = basename(filePath).toLowerCase();
  if (target.length === 0) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { name: string; score: number } | null = null;
  for (const name of entries) {
    const lower = name.toLowerCase();
    if (lower === target) return join(dir, name);
    const dist = editDistance(lower, target);
    const maxLen = Math.max(lower.length, target.length);
    if (maxLen === 0) continue;
    const similarity = 1 - dist / maxLen;
    const score = Math.round(similarity * 100);
    const threshold = target.length <= 4 ? 75 : 60;
    if (score >= threshold && (best === null || score > best.score)) {
      best = { name, score };
    }
  }
  return best ? join(dir, best.name) : null;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length;
  const n = b.length;
  let prev = new Array(n + 1).fill(0).map((_, j) => j);
  let curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? 0;
}

interface ReadInput {
  file_path?: unknown;
  offset?: unknown;
  limit?: unknown;
  pages?: unknown;
}

function err(toolUseId: string, msg: string): ToolResult {
  return { tool_use_id: toolUseId, content: msg, is_error: true };
}

function readSuffix(obj: Record<string, unknown>): string {
  const offset = typeof obj.offset === "number" ? obj.offset : null;
  const limit = typeof obj.limit === "number" ? obj.limit : null;
  const pages = typeof obj.pages === "string" ? obj.pages : null;
  if (pages) return ` · pages ${pages}`;
  if (offset !== null && limit !== null)
    return ` · lines ${offset}-${offset + Math.max(0, limit - 1)}`;
  if (offset !== null) return ` · from line ${offset}`;
  if (limit !== null) return ` · lines 1-${limit}`;
  return "";
}

export const Read: ToolHandler = {
  schema: {
    name: ReadSchema.name,
    description: getReadToolDescription({ lean: true }),
    inputSchema: ReadSchema.inputSchema,
  },
  isConcurrencySafe: true,
  render: {
    userFacingLabel(input) {
      const obj = (input ?? {}) as Record<string, unknown>;
      const fp = typeof obj.file_path === "string" ? obj.file_path : "";
      return taskIdFromOutputPath(fp) !== null ? "Read agent output" : "Read";
    },
    summarizeArgSegments(input) {
      const obj = (input ?? {}) as Record<string, unknown>;
      const fp = typeof obj.file_path === "string" ? obj.file_path : "";
      const taskId = taskIdFromOutputPath(fp);
      if (taskId !== null) return [{ kind: "text", text: taskId }];
      const segments: ToolArgSegment[] = [filePathSegment(fp)];
      const suffix = readSuffix(obj);
      if (suffix.length > 0) segments.push({ kind: "text", text: suffix });
      return segments;
    },
  },
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as ReadInput;
    const filePath = typeof args.file_path === "string" ? args.file_path : null;
    if (!filePath) return err(call.id, "file_path is required");
    if (isNetworkSharePath(filePath)) return err(call.id, NETWORK_SHARE_PATH_ERROR);
    if (!isAbsolute(filePath)) return err(call.id, "file_path must be absolute");

    if (STDIO_DEVICE_DENYLIST.has(filePath)) {
      return err(call.id, `blocked device path: ${filePath}`);
    }
    if (isHallucinatedTaskOutputPath(filePath)) {
      return err(
        call.id,
        "do not poll subagent output — wait for the completion notification. The agent's result lands via a system notification with an <output_file> path; only read that exact path.",
      );
    }

    const ext = extname(filePath).slice(1).toLowerCase();
    if (ext) {
      if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp") {
        return readImageBranch(call, ctx, filePath);
      }
      if (ext === "pdf") {
        const pages = typeof args.pages === "string" ? args.pages : null;
        return readPdfBranch(call, ctx, filePath, pages);
      }
      if (ext === "ipynb") return readNotebookBranch(call, ctx, filePath);
      if (BLOCKED_EXTENSIONS.has(ext)) {
        return err(call.id, `binary extension .${ext} cannot be read as text`);
      }
    }

    if (!existsSync(filePath)) {
      const suggestion = findSimilarFile(filePath);
      const tail = suggestion ? ` Did you mean ${suggestion}?` : "";
      return err(call.id, `File does not exist: ${filePath}.${tail}`);
    }
    let oversizedBytes = 0;
    try {
      const meta = statSync(filePath);
      if (meta.isDirectory()) {
        return err(
          call.id,
          `${filePath} is a directory, not a file. Use the Bash tool (ls) to list directory contents.`,
        );
      }
      if (meta.size > MAX_FILE_SIZE) oversizedBytes = meta.size;
    } catch {}

    const hasExplicitRange = typeof args.offset === "number" || typeof args.limit === "number";
    if (oversizedBytes > 0 && !hasExplicitRange) {
      return err(
        call.id,
        `file too large: ${oversizedBytes} bytes (max ${MAX_FILE_SIZE}). Pass offset and limit to read a specific range.`,
      );
    }

    const offset =
      typeof args.offset === "number" && Number.isFinite(args.offset)
        ? Math.max(0, Math.floor(args.offset))
        : 0;
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0
        ? Math.floor(args.limit)
        : DEFAULT_LIMIT;

    const scope = readScopeKey(ctx);
    const existing = readState(scope, filePath);
    if (
      existing &&
      existing.offset !== undefined &&
      existing.offset === offset &&
      existing.limit === limit
    ) {
      try {
        const currentMtime = statSync(filePath).mtimeMs;
        if (currentMtime === existing.timestamp) {
          return { tool_use_id: call.id, content: FILE_UNCHANGED_STUB };
        }
      } catch {}
    }

    let numbered: NumberedLines;
    let stateContent: string;
    if (oversizedBytes > 0) {
      try {
        numbered = await numberLinesFromStream(filePath, { offset, limit });
      } catch (e) {
        return err(call.id, `failed to read file: ${(e as Error).message}`);
      }
      // The read-state keeps only what the model saw — never the oversized file.
      stateContent = numbered.rawContent;
    } else {
      let fullText = "";
      try {
        fullText = await Bun.file(filePath).text();
      } catch {}
      numbered = formatNumberedLines(fullText, { offset, limit });
      stateContent = fullText;
    }
    const { output, rawContent, emitted, totalLines } = numbered;
    const startLine = offset + 1;

    const tokenCount = roughTokenCount(rawContent, ext);
    if (tokenCount > MAX_OUTPUT_TOKENS) return tokenCapError(call.id, tokenCount);

    readSetInsert(scope, filePath, stateContent, offset, limit);

    if (emitted === 0) {
      const warning =
        totalLines === 0
          ? "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>"
          : `<system-reminder>Warning: the file exists but is shorter than the provided offset (${startLine}). The file has ${totalLines} lines.</system-reminder>`;
      return {
        tool_use_id: call.id,
        content: warning,
        meta: { kind: "read", numLines: 0, startLine, totalLines },
      };
    }

    return {
      tool_use_id: call.id,
      content: output,
      meta: { kind: "read", numLines: emitted, startLine, totalLines },
    };
  },
};

interface NumberedLines {
  output: string;
  rawContent: string;
  emitted: number;
  totalLines: number;
}

export function formatNumberedLines(
  fullText: string,
  range: { offset?: number; limit?: number } = {},
): NumberedLines {
  const offset = range.offset ?? 0;
  const limit = range.limit ?? DEFAULT_LIMIT;
  const lines = fullText.split("\n");
  const sourceLines =
    lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  const totalLines = sourceLines.length;
  const numbered: string[] = [];
  let rawContent = "";
  let emitted = 0;
  for (let i = offset; i < sourceLines.length && emitted < limit; i++) {
    const lineText = sourceLines[i] ?? "";
    numbered.push(`${i + 1}\t${truncateLine(lineText)}`);
    rawContent += `${truncateLine(lineText)}\n`;
    emitted++;
  }
  return { output: numbered.join("\n"), rawContent, emitted, totalLines };
}

function truncateLine(lineText: string): string {
  const chars = Array.from(lineText);
  return chars.length > MAX_LINE_CHARS ? `${chars.slice(0, MAX_LINE_CHARS).join("")} …` : lineText;
}

// A carried line fragment past this never renders more than MAX_LINE_CHARS,
// so the rest of an oversized single line can be dropped while streaming.
const CARRY_CAP_CHARS = MAX_LINE_CHARS + 8;

// Range read for files above MAX_FILE_SIZE: lines outside offset/limit are
// counted and discarded, so memory stays bounded to a chunk plus one line.
export async function numberLinesFromStream(
  filePath: string,
  range: { offset: number; limit: number },
): Promise<NumberedLines> {
  const decoder = new TextDecoder();
  let carry = "";
  let lineIndex = 0;
  let emitted = 0;
  const numbered: string[] = [];
  let rawContent = "";

  const emitLine = (lineText: string): void => {
    if (lineIndex >= range.offset && emitted < range.limit) {
      const truncated = truncateLine(lineText);
      numbered.push(`${lineIndex + 1}\t${truncated}`);
      rawContent += `${truncated}\n`;
      emitted++;
    }
    lineIndex++;
  };

  const consume = (incoming: string): void => {
    let text = incoming;
    while (text.length > 0) {
      const nl = text.indexOf("\n");
      if (nl === -1) {
        if (carry.length < CARRY_CAP_CHARS) carry += text.slice(0, CARRY_CAP_CHARS - carry.length);
        return;
      }
      if (carry.length < CARRY_CAP_CHARS) {
        carry += text.slice(0, Math.min(nl, CARRY_CAP_CHARS - carry.length));
      }
      emitLine(carry);
      carry = "";
      text = text.slice(nl + 1);
    }
  };

  for await (const chunk of Bun.file(filePath).stream()) {
    consume(decoder.decode(chunk, { stream: true }));
  }
  consume(decoder.decode());
  if (carry.length > 0) emitLine(carry);

  return { output: numbered.join("\n"), rawContent, emitted, totalLines: lineIndex };
}

function readNotebookBranch(call: ToolCall, ctx: RequestContext, filePath: string): ToolResult {
  const result = readNotebookBlocks(filePath);
  if (typeof result === "string") return err(call.id, result);

  const byteLength = Buffer.byteLength(result.serialized);
  if (byteLength > MAX_FILE_SIZE) {
    return err(
      call.id,
      `Notebook content (${byteLength} bytes) exceeds maximum allowed size (${MAX_FILE_SIZE} bytes). Use the Bash tool with jq to read specific portions:\n  cat "${filePath}" | jq '.cells[:20]'  # first 20 cells\n  cat "${filePath}" | jq '.cells | length'  # count cells`,
    );
  }

  const tokenCount = roughTokenCount(result.serialized, "ipynb");
  if (tokenCount > MAX_OUTPUT_TOKENS) return tokenCapError(call.id, tokenCount);

  readSetInsert(readScopeKey(ctx), filePath, result.serialized);

  if (result.blocks.length === 0) {
    return { tool_use_id: call.id, content: "(notebook has no cells)" };
  }

  const blocks = canSendNatively(ctx.provider, ctx.model)
    ? result.blocks
    : result.blocks.filter((block) => block.type !== "image");
  return { tool_use_id: call.id, content: blocks };
}
