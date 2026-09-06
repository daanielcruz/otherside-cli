import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ephemeralAwareProjectPath } from "@/kernel/std/fs/paths.ts";

export const ENTRYPOINT_NAME = "MEMORY.md";
const MAX_ENTRYPOINT_LINES = 200;
const MAX_ENTRYPOINT_BYTES = 25_000;

export function autoMemDir(cwd: string): string {
  return join(ephemeralAwareProjectPath(cwd), "memory");
}

export function autoMemEntrypoint(cwd: string): string {
  return join(autoMemDir(cwd), ENTRYPOINT_NAME);
}

const ensuredDirs = new Set<string>();

export function ensureAutoMemDir(cwd: string): string {
  const dir = autoMemDir(cwd);
  if (ensuredDirs.has(dir)) return dir;
  try {
    mkdirSync(dir, { recursive: true });
    ensuredDirs.add(dir);
  } catch {}
  return dir;
}

function formatSize(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1) return `${bytes} bytes`;
  if (kb < 1024) return `${kb.toFixed(1).replace(/\.0$/, "")}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1).replace(/\.0$/, "")}MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1).replace(/\.0$/, "")}GB`;
}

interface TruncationStats {
  lineCount: number;
  byteCount: number;
  lineHit: boolean;
  byteHit: boolean;
}

function truncationReason(stats: TruncationStats): string {
  if (stats.byteHit && !stats.lineHit) {
    return `${formatSize(stats.byteCount)} (limit: ${formatSize(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`;
  }
  if (stats.lineHit && !stats.byteHit) {
    return `${stats.lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`;
  }
  return `${stats.lineCount} lines and ${formatSize(stats.byteCount)}`;
}

export function trimEntrypointContent(raw: string): string {
  const trimmed = raw.trim();
  const lines = trimmed.split("\n");
  const lineHit = lines.length > MAX_ENTRYPOINT_LINES;
  const byteHit = trimmed.length > MAX_ENTRYPOINT_BYTES;
  if (!lineHit && !byteHit) return trimmed;

  let truncated = lineHit ? lines.slice(0, MAX_ENTRYPOINT_LINES).join("\n") : trimmed;
  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf("\n", MAX_ENTRYPOINT_BYTES);
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES);
  }
  const reason = truncationReason({
    lineCount: lines.length,
    byteCount: trimmed.length,
    lineHit,
    byteHit,
  });
  return `${truncated}\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`;
}
