import { readdir, readFile, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneOrphanWorktrees } from "@/engine/background/subagents/worktree.ts";
import { ephemeralSessionsRoot } from "@/engine/session/paths.ts";
import { isSessionAlive } from "@/engine/session/registry.ts";
import { loadConfig } from "@/kernel/config/config.ts";
import {
  configRoot,
  isEphemeralSlug,
  projectsRoot,
  sessionRegistryDir,
  shellSnapshotsDir,
} from "@/kernel/std/fs/paths.ts";

const CLEANUP_SENTINEL = ".last-cleanup";
const CLEANUP_FRESHNESS_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_DAYS = 30;
const SCHEDULE_DELAY_MS = 5_000;
const EPHEMERAL_DIRS = ["shell-snapshots", "tasks", "file-history", "debug", "image-cache"];
const TOOL_RESULTS_DIRNAME = "tool-results";
const DEFAULT_TOOL_RESULTS_MAX_BYTES = 512 * 1024 * 1024;
const TOOL_RESULTS_FRESH_MS = DAY_MS;
const SNAPSHOT_PREFIX = "snapshot-";
const SNAPSHOT_SUFFIX = ".sh";
const SNAPSHOT_PID_PATTERN = /^snapshot-(?:zsh|bash)-(\d+)\.sh$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let scheduled = false;

export function scheduleRetentionCleanup(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    void pruneShellSnapshotsOnStartup().catch(() => {});
    void pruneOrphanTaskDirsOnStartup().catch(() => {});
    void runRetentionCleanup().catch(() => {});
  }, SCHEDULE_DELAY_MS).unref();
}

export function isSessionArtifact(name: string): boolean {
  if (UUID_PATTERN.test(name)) return true;
  if (!name.endsWith(".jsonl")) return false;
  return UUID_PATTERN.test(name.slice(0, -".jsonl".length));
}

export function getSessionIdFromEntry(entry: string): string | null {
  if (UUID_PATTERN.test(entry)) return entry;
  if (entry.endsWith(".jsonl")) {
    const candidate = entry.slice(0, -".jsonl".length);
    if (UUID_PATTERN.test(candidate)) return candidate;
  }
  return null;
}

async function cleanupPeriodDays(): Promise<number | null> {
  try {
    const cfg = await loadConfig();
    const v = cfg.cleanupPeriodDays;
    if (v === 0) return null;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  } catch {}
  return DEFAULT_CLEANUP_DAYS;
}

export async function runRetentionCleanup(now = Date.now()): Promise<void> {
  const root = configRoot();
  if (await isCleanupFresh(root, now)) return;
  const days = await cleanupPeriodDays();
  if (days === null) return;
  await claimCleanup(root);
  const cutoff = now - days * DAY_MS;
  await sweepProjects(cutoff);
  await sweepEphemeralSessions(cutoff);
  for (const dir of EPHEMERAL_DIRS) {
    await sweepEphemeralDir(join(root, dir), cutoff);
  }
  await sweepToolResultsBudget(now);
  await pruneOrphanWorktrees({ cwd: process.cwd(), cutoff }).catch(() => {});
}

function toolResultsBudgetBytes(): number | null {
  const raw = process.env.OTHERSIDE_TOOL_RESULTS_MAX_BYTES;
  if (raw === undefined) return DEFAULT_TOOL_RESULTS_MAX_BYTES;
  const parsed = Number.parseInt(raw, 10);
  if (parsed === 0) return null;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOOL_RESULTS_MAX_BYTES;
}

interface SpillEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

async function collectSpillFiles(roots: string[]): Promise<SpillEntry[]> {
  const entries: SpillEntry[] = [];
  for (const root of roots) {
    for (const slug of await safeReaddir(root)) {
      if (slug.startsWith(".")) continue;
      const slugDir = join(root, slug);
      for (const session of await safeReaddir(slugDir)) {
        if (session.startsWith(".")) continue;
        if (isSessionAlive(session)) continue;
        const dir = join(slugDir, session, TOOL_RESULTS_DIRNAME);
        for (const file of await safeReaddir(dir)) {
          const path = join(dir, file);
          try {
            const info = await stat(path);
            if (info.isFile()) entries.push({ path, size: info.size, mtimeMs: info.mtimeMs });
          } catch {}
        }
      }
    }
  }
  return entries;
}

function toolResultsTtlMs(): number {
  const raw = process.env.OTHERSIDE_TOOL_RESULTS_TTL_DAYS;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed * DAY_MS;
    }
  }
  return 7 * DAY_MS;
}

export async function sweepToolResultsBudget(now: number): Promise<void> {
  const files = await collectSpillFiles([projectsRoot(), ephemeralSessionsRoot()]);
  const ttlMs = toolResultsTtlMs();
  const ttlCutoff = now - ttlMs;
  const remainingFiles: SpillEntry[] = [];
  for (const file of files) {
    if (file.mtimeMs < ttlCutoff) {
      try {
        await unlink(file.path);
      } catch {}
    } else {
      remainingFiles.push(file);
    }
  }
  const budget = toolResultsBudgetBytes();
  if (budget === null) return;
  let total = remainingFiles.reduce((sum, file) => sum + file.size, 0);
  if (total <= budget) return;
  const freshCutoff = now - TOOL_RESULTS_FRESH_MS;
  const evictable = remainingFiles
    .filter((file) => file.mtimeMs < freshCutoff)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of evictable) {
    if (total <= budget) break;
    try {
      await unlink(file.path);
      total -= file.size;
    } catch {}
  }
}

async function isCleanupFresh(root: string, now: number): Promise<boolean> {
  try {
    const sentinel = await stat(join(root, CLEANUP_SENTINEL));
    return now - sentinel.mtimeMs < CLEANUP_FRESHNESS_MS;
  } catch {
    return false;
  }
}

async function claimCleanup(root: string): Promise<void> {
  try {
    await writeFile(join(root, CLEANUP_SENTINEL), new Date().toISOString());
  } catch {}
}

async function hasNonEmptyMemoryDir(slugDir: string): Promise<boolean> {
  try {
    const entries = await readdir(join(slugDir, "memory"));
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function sweepProjects(cutoff: number): Promise<void> {
  const root = projectsRoot();
  for (const slug of await safeReaddir(root)) {
    if (slug.startsWith(".")) continue;
    if (isEphemeralSlug(slug) && !(await hasNonEmptyMemoryDir(join(root, slug)))) {
      const slugDir = join(root, slug);
      const entries = await safeReaddir(slugDir);
      let hasLive = false;
      for (const entry of entries) {
        const sessionId = getSessionIdFromEntry(entry);
        if (sessionId && isSessionAlive(sessionId)) {
          hasLive = true;
          break;
        }
      }
      if (!hasLive) {
        await rm(slugDir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
    }
    await sweepProjectSlug(join(root, slug), cutoff);
  }
}

async function sweepEphemeralSessions(cutoff: number): Promise<void> {
  const root = ephemeralSessionsRoot();
  for (const slug of await safeReaddir(root)) {
    if (slug.startsWith(".")) continue;
    await sweepProjectSlug(join(root, slug), cutoff);
  }
}

async function sweepProjectSlug(slugDir: string, cutoff: number): Promise<void> {
  for (const entry of await safeReaddir(slugDir)) {
    if (entry.startsWith(".")) continue;
    if (!isSessionArtifact(entry)) continue;
    const sessionId = getSessionIdFromEntry(entry);
    if (sessionId && isSessionAlive(sessionId)) continue;
    await removeIfExpired(join(slugDir, entry), cutoff);
  }
  await rmdirIfEmpty(slugDir);
}

async function rmdirIfEmpty(dir: string): Promise<void> {
  try {
    const remaining = await readdir(dir);
    if (remaining.length === 0) await rmdir(dir);
  } catch {}
}

async function sweepEphemeralDir(dir: string, cutoff: number): Promise<void> {
  for (const entry of await safeReaddir(dir)) {
    if (entry.startsWith(".")) continue;
    if (UUID_PATTERN.test(entry) && isSessionAlive(entry)) continue;
    await removeIfExpired(join(dir, entry), cutoff);
  }
}

async function removeIfExpired(target: string, cutoff: number): Promise<void> {
  try {
    const info = await stat(target);
    if (info.mtimeMs >= cutoff) return;
    await rm(target, { recursive: true, force: true });
  } catch {}
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

function startOfTodayMs(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function pruneShellSnapshotsOnStartup(now = Date.now()): Promise<void> {
  if ((await cleanupPeriodDays()) === null) return;
  const dir = shellSnapshotsDir();
  const cutoff = startOfTodayMs(now);
  for (const entry of await safeReaddir(dir)) {
    if (!entry.startsWith(SNAPSHOT_PREFIX) || !entry.endsWith(SNAPSHOT_SUFFIX)) continue;
    const target = join(dir, entry);
    const pidMatch = entry.match(SNAPSHOT_PID_PATTERN);
    if (pidMatch !== null) {
      const pidRaw = pidMatch[1];
      const pid = pidRaw !== undefined ? Number.parseInt(pidRaw, 10) : Number.NaN;
      if (!Number.isNaN(pid) && pid !== process.pid && !isProcessAlive(pid)) {
        await unlink(target).catch(() => {});
      }
      continue;
    }
    try {
      const info = await stat(target);
      if (info.isFile() && info.mtimeMs < cutoff) await unlink(target);
    } catch {}
  }
}

export async function pruneOrphanTaskDirsOnStartup(): Promise<void> {
  await pruneOrphanTaskDirs(Date.now());
}

export async function pruneOrphanTaskDirs(now = Date.now(), customTmpDir?: string): Promise<void> {
  const baseTmp = customTmpDir ?? tmpdir();
  const candidates = await safeReaddir(baseTmp);
  const liveSessions = await getLiveSessionsFromRegistry();
  for (const entry of candidates) {
    if (!entry.startsWith("otherside-")) continue;
    const othersideDir = join(baseTmp, entry);
    await pruneDir(othersideDir, liveSessions, now);
  }
}

async function getLiveSessionsFromRegistry(): Promise<{ pid: number; sanitized: string }[]> {
  const dir = sessionRegistryDir();
  const entries: { pid: number; sanitized: string }[] = [];
  try {
    const files = await readdir(dir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const sessionId = file.slice(0, -".json".length);
      const path = join(dir, file);
      try {
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw);
        if (typeof parsed.pid === "number") {
          if (isProcessAlive(parsed.pid)) {
            entries.push({
              pid: parsed.pid,
              sanitized: sessionId.replace(/[^A-Za-z0-9_-]/g, "_"),
            });
          }
        }
      } catch {}
    }
  } catch {}
  return entries;
}

async function pruneDir(
  dirPath: string,
  liveSessions: { pid: number; sanitized: string }[],
  now: number,
): Promise<boolean> {
  const segments = dirPath.split(/[/\\]/);
  for (const segment of segments) {
    if (segment.startsWith("pid-")) {
      const pidRaw = segment.slice("pid-".length);
      const pid = Number.parseInt(pidRaw, 10);
      if (!Number.isNaN(pid) && isProcessAlive(pid)) {
        return true;
      }
    }
    if (liveSessions.some((s) => s.sanitized === segment)) {
      return true;
    }
  }
  try {
    const stats = await stat(dirPath);
    if (now - stats.mtimeMs < 60 * 60 * 1000) {
      return true;
    }
  } catch {
    return true;
  }
  const entries = await safeReaddir(dirPath);
  let hasActiveChildren = false;
  for (const entry of entries) {
    const childPath = join(dirPath, entry);
    try {
      const childStats = await stat(childPath);
      if (childStats.isDirectory()) {
        const isActive = await pruneDir(childPath, liveSessions, now);
        if (isActive) {
          hasActiveChildren = true;
        }
      } else {
        if (now - childStats.mtimeMs < 60 * 60 * 1000) {
          hasActiveChildren = true;
        } else {
          await unlink(childPath).catch(() => {});
        }
      }
    } catch {
      hasActiveChildren = true;
    }
  }
  if (hasActiveChildren) {
    return true;
  }
  try {
    await rm(dirPath, { recursive: true, force: true });
    return false;
  } catch {
    return true;
  }
}
