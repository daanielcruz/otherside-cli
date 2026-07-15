import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { structuredPatch } from "diff";
import { fileHistoryRoot } from "@/kernel/std/fs/paths.ts";
import { chmodIfPosix } from "@/kernel/std/fs/secure-fs.ts";

const MAX_SNAPSHOTS_PER_SESSION = 100;

export type FileSnapshot =
  | {
      sessionId: string;
      turnId: string;
      filePath: string;
      existed: false;
      ts: number;
    }
  | {
      sessionId: string;
      turnId: string;
      filePath: string;
      existed: true;
      backupPath: string;
      mode: number | null;
      ts: number;
    };

interface SnapshotIndex {
  snapshots: FileSnapshot[];
  // sha1 of the file content as THIS session last wrote it (structured
  // mutation paths). Restore uses it to spot files another session touched
  // afterwards and skips them instead of silently destroying foreign work.
  lastWritten?: Record<string, string>;
}

const activeTurns = new Map<string, string>();
const indexCache = new Map<string, SnapshotIndex>();

function indexPath(sessionId: string): string {
  return join(fileHistoryRoot(sessionId), "index.json");
}

function backupDir(sessionId: string, turnId: string): string {
  return join(fileHistoryRoot(sessionId), turnId);
}

function loadIndex(sessionId: string): SnapshotIndex {
  const cached = indexCache.get(sessionId);
  if (cached) return cached;
  const path = indexPath(sessionId);
  let idx: SnapshotIndex = { snapshots: [] };
  try {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      const parsed = JSON.parse(text) as SnapshotIndex;
      if (parsed && Array.isArray(parsed.snapshots)) idx = parsed;
    }
  } catch {}
  indexCache.set(sessionId, idx);
  return idx;
}

function persistIndex(sessionId: string, idx: SnapshotIndex): void {
  const path = indexPath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(idx));
}

function fileNameHash(filePath: string): string {
  return createHash("sha1").update(filePath).digest("hex").slice(0, 16);
}

function contentHash(buffer: Buffer | string): string {
  return createHash("sha1").update(buffer).digest("hex");
}

function diskContentHash(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    return contentHash(readFileSync(filePath));
  } catch {
    return null;
  }
}

// Called by the structured mutation tools after a successful write, so restore
// can tell this session's own edits from a concurrent session's. Only useful
// when a turn is armed — an unarmed session never restores.
export function recordFileMutationResult(
  ctx: { sessionId: string; rewindTurnId?: string },
  filePath: string,
): void {
  const turnId = ctx.rewindTurnId ?? activeTurns.get(ctx.sessionId);
  if (!turnId) return;
  const hash = diskContentHash(filePath);
  if (hash === null) return;
  const idx = loadIndex(ctx.sessionId);
  idx.lastWritten = { ...idx.lastWritten, [filePath]: hash };
  persistIndex(ctx.sessionId, idx);
}

export function setActiveRewindTurn(sessionId: string, turnId: string | null): void {
  if (turnId === null) {
    activeTurns.delete(sessionId);
    return;
  }
  activeTurns.set(sessionId, turnId);
}

// The turn currently armed for a session, read at sub-agent/skill spawn so the
// child can freeze it onto its context and attribute later mutations correctly.
export function getActiveRewindTurn(sessionId: string): string | undefined {
  return activeTurns.get(sessionId);
}

export async function snapshotBeforeFileMutation(
  ctx: { sessionId: string; rewindTurnId?: string },
  filePath: string,
): Promise<void> {
  const turnId = ctx.rewindTurnId ?? activeTurns.get(ctx.sessionId);
  if (!turnId) return;
  const idx = loadIndex(ctx.sessionId);
  if (idx.snapshots.some((s) => s.turnId === turnId && s.filePath === filePath)) {
    return;
  }
  if (!existsSync(filePath)) {
    idx.snapshots.push({
      sessionId: ctx.sessionId,
      turnId,
      filePath,
      existed: false,
      ts: Date.now(),
    });
    enforceCap(idx);
    persistIndex(ctx.sessionId, idx);
    return;
  }
  let mode: number | null = null;
  try {
    mode = statSync(filePath).mode & 0o777;
  } catch {}
  const dir = backupDir(ctx.sessionId, turnId);
  mkdirSync(dir, { recursive: true });
  const backupPath = join(dir, `${fileNameHash(filePath)}@v1`);
  try {
    copyFileSync(filePath, backupPath);
  } catch {
    return;
  }
  idx.snapshots.push({
    sessionId: ctx.sessionId,
    turnId,
    filePath,
    existed: true,
    backupPath,
    mode,
    ts: Date.now(),
  });
  enforceCap(idx);
  persistIndex(ctx.sessionId, idx);
}

function enforceCap(idx: SnapshotIndex): void {
  if (idx.snapshots.length <= MAX_SNAPSHOTS_PER_SESSION) return;
  const overflow = idx.snapshots.length - MAX_SNAPSHOTS_PER_SESSION;
  const dropped = idx.snapshots.splice(0, overflow);
  for (const snap of dropped) {
    if (snap.existed) {
      try {
        unlinkSync(snap.backupPath);
      } catch {}
    }
  }
}

export function fileSnapshotStatsForTurn(
  sessionId: string,
  turnId: string,
): { filesChanged: string[] } {
  const idx = loadIndex(sessionId);
  const filesChanged = [
    ...new Set(idx.snapshots.filter((s) => s.turnId === turnId).map((s) => s.filePath)),
  ];
  return { filesChanged };
}

export interface RestoreDiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export function fileRestoreDiffStatsForTurn(sessionId: string, turnId: string): RestoreDiffStats {
  const idx = loadIndex(sessionId);
  const firstByFile = new Map<string, FileSnapshot>();
  for (const snapshot of idx.snapshots) {
    if (snapshot.turnId !== turnId) continue;
    if (!firstByFile.has(snapshot.filePath)) firstByFile.set(snapshot.filePath, snapshot);
  }
  let insertions = 0;
  let deletions = 0;
  for (const snapshot of firstByFile.values()) {
    const current = readTextOrEmpty(snapshot.filePath);
    const restoreTarget = snapshot.existed ? readTextOrEmpty(snapshot.backupPath) : "";
    if (current === restoreTarget) continue;
    const patch = structuredPatch(
      snapshot.filePath,
      snapshot.filePath,
      current,
      restoreTarget,
      "",
      "",
    );
    for (const hunk of patch.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) insertions += 1;
        else if (line.startsWith("-")) deletions += 1;
      }
    }
  }
  return { filesChanged: firstByFile.size, insertions, deletions };
}

function readTextOrEmpty(filePath: string): string {
  try {
    if (!existsSync(filePath)) return "";
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

export function restoreFilesForRewind(
  sessionId: string,
  turnIds: string[],
): { filesRestored: number; skippedExternallyModified: string[] } {
  const selected = new Set(turnIds);
  const idx = loadIndex(sessionId);
  const firstByFile = new Map<string, FileSnapshot>();
  for (const snapshot of idx.snapshots) {
    if (!selected.has(snapshot.turnId)) continue;
    if (!firstByFile.has(snapshot.filePath)) firstByFile.set(snapshot.filePath, snapshot);
  }
  const skippedExternallyModified: string[] = [];
  let filesRestored = 0;
  for (const snapshot of firstByFile.values()) {
    // Fail closed on foreign work: when this session knows the content it
    // last wrote and the disk matches neither that nor the restore target,
    // another session touched the file since — skip it, never overwrite.
    // Files without a lastWritten record (untracked mutation paths) keep the
    // plain overwrite behavior.
    const lastWritten = idx.lastWritten?.[snapshot.filePath];
    if (lastWritten !== undefined) {
      const disk = diskContentHash(snapshot.filePath);
      const restoreTarget = snapshot.existed ? diskContentHash(snapshot.backupPath) : null;
      if (disk !== null && disk !== lastWritten && disk !== restoreTarget) {
        skippedExternallyModified.push(snapshot.filePath);
        continue;
      }
    }
    if (!snapshot.existed) {
      try {
        if (existsSync(snapshot.filePath)) unlinkSync(snapshot.filePath);
        filesRestored += 1;
      } catch {}
      continue;
    }
    try {
      mkdirSync(dirname(snapshot.filePath), { recursive: true });
      const content = readFileSync(snapshot.backupPath);
      writeFileSync(snapshot.filePath, content);
      if (snapshot.mode !== null) chmodIfPosix(snapshot.filePath, snapshot.mode);
      filesRestored += 1;
    } catch {}
  }
  return { filesRestored, skippedExternallyModified };
}

// Drop the in-memory file-history maps for a session (e.g. on /clear, when the
// session id is about to change). On-disk backups are intentionally left — they
// are reclaimed by an age-based cleanup pass, not on clear.
export function evictFileHistoryCache(sessionId: string): void {
  activeTurns.delete(sessionId);
  indexCache.delete(sessionId);
}

// Full per-session purge: in-memory maps + the on-disk backup directory. For an
// explicit purge, not the /clear path.
export function clearFileHistoryForSession(sessionId: string): void {
  evictFileHistoryCache(sessionId);
  try {
    rmSync(fileHistoryRoot(sessionId), { recursive: true, force: true });
  } catch {}
}
