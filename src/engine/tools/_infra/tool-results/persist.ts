import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalizeCwd,
  isEphemeralCwd,
  MAX_PERSISTED_TOOL_OUTPUT_BYTES,
  projectPath,
  projectSlug,
} from "@/kernel/std/fs/paths.ts";
import { capUtf8ToBytes } from "@/kernel/std/text/text.ts";

const PERSIST_THRESHOLD = 30_000;
const PREVIEW_HEAD = 4_000;
const PREVIEW_TAIL = 4_000;
const MAX_FILES = 200;

export interface PersistedToolResult {
  preview: string;
  filePath: string;
  totalChars: number;
}

interface PersistScope {
  cwd: string;
  sessionId: string;
}

function resultsDir(scope: PersistScope): string {
  if (process.env.OTHERSIDE_TOOL_RESULTS_DIR) return process.env.OTHERSIDE_TOOL_RESULTS_DIR;
  const canonCwd = canonicalizeCwd(scope.cwd);
  const base = isEphemeralCwd(canonCwd)
    ? join(tmpdir(), "otherside-sessions", projectSlug(canonCwd))
    : projectPath(canonCwd);
  return join(base, scope.sessionId, "tool-results");
}

function ensureDir(scope: PersistScope): string {
  const dir = resultsDir(scope);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

function rotate(dir: string): void {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".txt"));
  } catch {
    return;
  }
  if (files.length <= MAX_FILES) return;
  const sorted = files
    .map((f) => {
      try {
        return { f, mtime: statSync(join(dir, f)).mtimeMs };
      } catch {
        return { f, mtime: 0 };
      }
    })
    .sort((a, b) => a.mtime - b.mtime);
  const toDrop = sorted.slice(0, sorted.length - MAX_FILES);
  for (const { f } of toDrop) {
    try {
      unlinkSync(join(dir, f));
    } catch {}
  }
}

function safeSlug(input: string, maxLen = 32): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, maxLen) || "tool";
}

export function shouldPersist(totalChars: number): boolean {
  return totalChars > PERSIST_THRESHOLD;
}

export function getPersistThreshold(): number {
  return PERSIST_THRESHOLD;
}

function buildPreview(content: string, totalChars: number, filePath: string): string {
  const head = content.slice(0, PREVIEW_HEAD);
  const tail = content.slice(content.length - PREVIEW_TAIL);
  const dropped = totalChars - PREVIEW_HEAD - PREVIEW_TAIL;
  return `${head}\n[... ${dropped} chars truncated; full output persisted to ${filePath} ...]\n${tail}`;
}

export function persistLargeToolResult(opts: {
  toolName: string;
  callId: string;
  content: string;
  cwd: string;
  sessionId: string;
}): PersistedToolResult {
  const totalChars = opts.content.length;
  if (!shouldPersist(totalChars)) {
    return { preview: opts.content, filePath: "", totalChars };
  }
  const dir = ensureDir({ cwd: opts.cwd, sessionId: opts.sessionId });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${ts}-${safeSlug(opts.toolName)}-${safeSlug(opts.callId)}.txt`;
  const filePath = join(dir, filename);
  try {
    writeFileSync(filePath, capUtf8ToBytes(opts.content, MAX_PERSISTED_TOOL_OUTPUT_BYTES));
    rotate(dir);
  } catch {
    return { preview: opts.content, filePath: "", totalChars };
  }
  return {
    preview: buildPreview(opts.content, totalChars, filePath),
    filePath,
    totalChars,
  };
}
