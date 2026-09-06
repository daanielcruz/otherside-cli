import { git } from "./worktree-git.ts";
import { samePath } from "./worktree-path.ts";
import type { SessionWorktreeState } from "./worktree-state.ts";

const SESSION_LOCK_PREFIX = "otherside session";

interface RegisteredWorktree {
  worktreePath: string;
  worktreeBranch?: string;
  lockReason?: string;
  prunable?: boolean;
}

export async function listSessionWorktrees(repoRoot: string): Promise<RegisteredWorktree[]> {
  const listed = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!listed.ok) throw new Error(`git worktree list failed for ${repoRoot}`);
  const entries: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | null = null;
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current !== null) entries.push(current);
      current = { worktreePath: line.slice("worktree ".length) };
    } else if (current !== null && line.startsWith("branch ")) {
      current.worktreeBranch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (current !== null && (line === "locked" || line.startsWith("locked "))) {
      current.lockReason = line.slice("locked".length).trim();
    } else if (current !== null && (line === "prunable" || line.startsWith("prunable "))) {
      current.prunable = true;
    }
  }
  if (current !== null) entries.push(current);
  return entries;
}

export async function assertRegisteredWorktree(repoRoot: string, path: string): Promise<void> {
  const registered = await listSessionWorktrees(repoRoot);
  if (!registered.some((entry) => samePath(entry.worktreePath, path))) {
    throw new Error(`${path} is not a registered worktree of ${repoRoot}`);
  }
}

function sessionLockReason(sessionId: string): string {
  return `${SESSION_LOCK_PREFIX} ${sessionId} (pid ${process.pid})`;
}

function lockPid(reason: string): number | null {
  const raw = /\bpid (\d+)\b/.exec(reason)?.[1];
  if (raw === undefined) return null;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isLiveForeignSessionLock(reason: string): boolean {
  if (!reason.startsWith(SESSION_LOCK_PREFIX)) return true;
  const pid = lockPid(reason);
  return pid !== null && pid !== process.pid && processIsRunning(pid);
}

export async function lockReasonFor(path: string, repoRoot: string): Promise<string | undefined> {
  const registered = await listSessionWorktrees(repoRoot);
  return registered.find((entry) => samePath(entry.worktreePath, path))?.lockReason;
}

export async function acquireSessionWorktreeLock(
  path: string,
  repoRoot: string,
  sessionId: string,
): Promise<{ owned: boolean; reason?: string }> {
  const wanted = sessionLockReason(sessionId);
  let current = await lockReasonFor(path, repoRoot);
  if (current === wanted) return { owned: true, reason: wanted };
  if (current !== undefined) {
    if (isLiveForeignSessionLock(current)) return { owned: false, reason: current };
    const pid = lockPid(current);
    if (!current.startsWith(SESSION_LOCK_PREFIX) || (pid !== null && processIsRunning(pid))) {
      return { owned: false, reason: current };
    }
    await git(repoRoot, ["worktree", "unlock", path]);
  }
  const locked = await git(repoRoot, ["worktree", "lock", "--reason", wanted, path]);
  if (!locked.ok) {
    current = await lockReasonFor(path, repoRoot).catch(() => undefined);
    return current === undefined ? { owned: false } : { owned: false, reason: current };
  }
  return { owned: true, reason: wanted };
}

export async function releaseSessionWorktreeLock(active: SessionWorktreeState): Promise<void> {
  if (
    active.hookBased ||
    active.ownership !== "created" ||
    active.ownerRepoRoot === undefined ||
    active.lockReason === undefined
  ) {
    return;
  }
  const current = await lockReasonFor(active.activePath, active.ownerRepoRoot).catch(
    () => undefined,
  );
  if (current === active.lockReason && lockPid(current) === process.pid) {
    await git(active.ownerRepoRoot, ["worktree", "unlock", active.activePath]);
  }
}

export async function mayRemoveSessionWorktree(
  active: SessionWorktreeState,
  repoRoot: string,
): Promise<boolean> {
  if (active.ownership !== "created" || active.lockReason === undefined) return false;
  try {
    const current = await lockReasonFor(active.activePath, repoRoot);
    return current === active.lockReason && lockPid(current) === process.pid;
  } catch {
    return false;
  }
}
