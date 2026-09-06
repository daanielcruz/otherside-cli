import { readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { privateGitDir } from "./worktree-git.ts";
import { errnoCode } from "./worktree-lock.ts";

const LEASE_FILENAME = "otherside-lease.json";
const LEASE_VERSION = 1;
// A lease from another host cannot be probed by pid; trust it only while fresh.
const LEASE_CROSS_HOST_TTL_MS = 6 * 60 * 60 * 1000;

interface WorktreeLeaseRecord {
  version: typeof LEASE_VERSION;
  pid: number;
  host: string;
  updatedAt: number;
}

// A run-lifetime claim on a worktree. It is NOT taken at creation — the run
// layer (fork loop / workflow bridge) acquires it once it starts driving the
// worktree and releases it before cleanup, so orphan pruning can tell a live
// agent's worktree from a truly abandoned one regardless of its age.
export interface WorktreeLease {
  release: () => Promise<void>;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH → gone; EPERM → exists but owned by another user.
    return errnoCode(error) === "EPERM";
  }
}

function parseLease(raw: string): WorktreeLeaseRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<WorktreeLeaseRecord>;
    if (value.version !== LEASE_VERSION) return null;
    if (typeof value.pid !== "number" || !Number.isInteger(value.pid)) return null;
    if (typeof value.host !== "string" || value.host.length === 0) return null;
    if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return null;
    return value as WorktreeLeaseRecord;
  } catch {
    return null;
  }
}

async function leaseFilePath(path: string): Promise<string | null> {
  const gitDir = await privateGitDir(path);
  return gitDir === null ? null : join(gitDir, LEASE_FILENAME);
}

export async function acquireWorktreeLease(path: string): Promise<WorktreeLease> {
  const file = await leaseFilePath(path);
  const record: WorktreeLeaseRecord = {
    version: LEASE_VERSION,
    pid: process.pid,
    host: hostname(),
    updatedAt: Date.now(),
  };
  if (file !== null) {
    try {
      await writeFile(file, JSON.stringify(record), "utf-8");
    } catch {}
  }
  let released = false;
  return {
    async release() {
      if (released || file === null) return;
      released = true;
      try {
        // Drop the marker only if it is still ours — a crash-stealer that rewrote
        // the lease for the same path must keep its own claim.
        const current = parseLease(await readFile(file, "utf-8"));
        if (current !== null && current.pid === process.pid && current.host === record.host) {
          await rm(file, { force: true });
        }
      } catch {}
    },
  };
}

// A resumed fork reuses the isolation worktree its original run created instead
// of going through createWorktree (which would re-run the git setup). Refresh
// the directory mtime so the orphan prune's age check treats it as active, then
// take the same run-lifetime lease the fork loop holds so the prune's
// fail-closed guard cannot reclaim the worktree under the live resumed agent.
// The caller releases the returned lease when the resumed run settles.
export async function acquireResumedWorktreeLease(path: string): Promise<WorktreeLease> {
  try {
    const now = new Date();
    await utimes(path, now, now);
  } catch {}
  return acquireWorktreeLease(path);
}

export async function isWorktreeLeaseLive(path: string): Promise<boolean> {
  const file = await leaseFilePath(path);
  if (file === null) return false;
  let record: WorktreeLeaseRecord | null;
  try {
    record = parseLease(await readFile(file, "utf-8"));
  } catch {
    // No marker → not live (released cleanly, or was never leased).
    return false;
  }
  if (record === null) return false;
  if (record.host === hostname()) return pidAlive(record.pid);
  return Date.now() - record.updatedAt < LEASE_CROSS_HOST_TTL_MS;
}
