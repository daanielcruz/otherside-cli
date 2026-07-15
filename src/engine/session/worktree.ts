import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadConfigSync, type UserConfig } from "@/kernel/config/config.ts";
import { fireWorktreeCreateHooks, fireWorktreeRemoveHooks } from "@/kernel/hooks/handler.ts";
import { worktreePathsForAsync } from "@/kernel/std/fs/paths.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { sessionPathForCwd } from "./paths.ts";
import type { Session } from "./record/state.ts";

/**
 * Session-scoped worktree state (EnterWorktree/ExitWorktree foundation).
 * Distinct from Agent-isolation worktrees under `otherside/agent/*`, which
 * overlay dirty files and only auto-remove pristine trees.
 */
export type SessionWorktreeState = {
  originalCwd: string;
  activePath: string;
  managedBranch?: string;
  baseSha?: string;
  ownership: "created" | "enteredExisting";
  tmuxSession?: string;
};

export type SessionWorktreeStamp = {
  originalCwd: string;
  activePath: string;
  managedBranch?: string;
  baseSha?: string;
  ownership: "created" | "enteredExisting";
  tmuxSession?: string;
};

const liveHosts = new Map<string, Session>();
/** Per-subagent/fork controllers — never mutate the parent session cwd. */
const subagentControllers = new Map<string, SessionWorktreeState>();

const AGENT_ISOLATION_BRANCH_PREFIX = "otherside/agent/";
const SESSION_BRANCH_PREFIX = "worktree-";

export function attachSessionWorktreeHost(session: Session): void {
  liveHosts.set(session.id, session);
}

export function detachSessionWorktreeHost(sessionId: string): void {
  liveHosts.delete(sessionId);
  const prefix = `${sessionId}::`;
  for (const key of subagentControllers.keys()) {
    if (key.startsWith(prefix)) subagentControllers.delete(key);
  }
}

export function getActiveWorktree(ctx: RequestContext): SessionWorktreeState | null {
  const subKey = subagentControllerKey(ctx);
  if (subKey !== null) return subagentControllers.get(subKey) ?? null;
  const host = liveHosts.get(ctx.sessionId);
  return host?.worktree ?? null;
}

export async function enterSessionWorktree(
  ctx: RequestContext,
  opts: { name?: string; path?: string },
): Promise<{ worktreePath: string; worktreeBranch?: string; message: string }> {
  const existing = getActiveWorktree(ctx);
  if (existing !== null) {
    // Switch/re-enter: leave previous on disk (keep), then enter target.
    await applyExitKeep(ctx, existing);
  }

  const storageCwd = resolveStorageCwd(ctx);
  const repoRoot = await canonicalGitRoot(storageCwd);
  if (repoRoot === null) {
    throw new Error("session worktree: not inside a git repository");
  }

  if (typeof opts.path === "string" && opts.path.trim().length > 0) {
    const target = resolve(opts.path.trim());
    await assertRegisteredWorktree(repoRoot, target);
    if (await isAgentIsolationWorktree(target)) {
      throw new Error(
        "session worktree: refusing to enter an Agent-isolation worktree via EnterWorktree",
      );
    }
    const branch = await currentBranch(target);
    const state: SessionWorktreeState = {
      originalCwd: storageCwd,
      activePath: target,
      ownership: "enteredExisting",
      ...(branch !== null && isSessionManagedBranch(branch) ? { managedBranch: branch } : {}),
    };
    applyEnter(ctx, state);
    return {
      worktreePath: target,
      ...(state.managedBranch !== undefined ? { worktreeBranch: state.managedBranch } : {}),
      message: `Entered existing worktree at ${target}`,
    };
  }

  const name = sanitizeWorktreeName(opts.name ?? autoWorktreeName());
  const flattened = flattenWorktreeName(name);
  const managedPath = join(repoRoot, ".otherside", "worktrees", flattened);
  const managedBranch = `${SESSION_BRANCH_PREFIX}${flattened}`;

  // Resume an already-managed session worktree if present.
  if (await pathExists(managedPath)) {
    try {
      await assertRegisteredWorktree(repoRoot, managedPath);
      const branch = await currentBranch(managedPath);
      if (branch === managedBranch || (branch !== null && isSessionManagedBranch(branch))) {
        const head = await revParse(managedPath, "HEAD");
        const resumedBranch = branch ?? managedBranch;
        const state: SessionWorktreeState = {
          originalCwd: storageCwd,
          activePath: managedPath,
          managedBranch: resumedBranch,
          ownership: "enteredExisting",
          ...(head !== null ? { baseSha: head } : {}),
        };
        applyEnter(ctx, state);
        return {
          worktreePath: managedPath,
          worktreeBranch: resumedBranch,
          message: `Resumed managed worktree ${name} at ${managedPath}`,
        };
      }
    } catch {
      // Fall through to create / hook path.
    }
  }

  const config = loadConfigSync();
  const hookPath = await firstNonemptyHookPath(config, name);
  if (hookPath !== null) {
    const resolved = resolve(hookPath);
    if (!(await pathExists(resolved))) {
      throw new Error(`session worktree: WorktreeCreate hook returned missing path ${resolved}`);
    }
    const branch = await currentBranch(resolved);
    const head = await revParse(resolved, "HEAD");
    const state: SessionWorktreeState = {
      originalCwd: storageCwd,
      activePath: resolved,
      ownership: "created",
      ...(branch !== null ? { managedBranch: branch } : {}),
      ...(head !== null ? { baseSha: head } : {}),
    };
    applyEnter(ctx, state);
    return {
      worktreePath: resolved,
      ...(state.managedBranch !== undefined ? { worktreeBranch: state.managedBranch } : {}),
      message: `Entered worktree from WorktreeCreate hook at ${resolved}`,
    };
  }

  const baseRef = await resolveBaseRef(repoRoot, config);
  const baseSha = await revParse(repoRoot, baseRef);
  if (baseSha === null) {
    throw new Error(`session worktree: could not resolve base ref ${baseRef}`);
  }

  await mkdir(dirname(managedPath), { recursive: true });
  const added = await git(repoRoot, ["worktree", "add", "-B", managedBranch, managedPath, baseSha]);
  if (!added.ok) {
    // Clean partials if any.
    await git(repoRoot, ["worktree", "remove", "--force", managedPath]);
    await git(repoRoot, ["branch", "-D", managedBranch]);
    await rm(managedPath, { recursive: true, force: true }).catch(() => {});
    throw new Error(`session worktree: git worktree add failed for ${managedPath}`);
  }

  const state: SessionWorktreeState = {
    originalCwd: storageCwd,
    activePath: managedPath,
    managedBranch,
    baseSha,
    ownership: "created",
  };
  applyEnter(ctx, state);
  return {
    worktreePath: managedPath,
    worktreeBranch: managedBranch,
    message: `Created worktree ${name} at ${managedPath} (base ${baseRef})`,
  };
}

export async function exitSessionWorktree(
  ctx: RequestContext,
  opts: { action: "keep" | "remove"; discardChanges?: boolean },
): Promise<{
  action: string;
  originalCwd: string;
  worktreePath?: string;
  worktreeBranch?: string;
  discardedFiles?: number;
  discardedCommits?: number;
  message: string;
}> {
  const active = getActiveWorktree(ctx);
  if (active === null) {
    throw new Error("session worktree: not currently inside a session worktree");
  }

  if (await isAgentIsolationWorktree(active.activePath)) {
    throw new Error("session worktree: removal/exit of an Agent-isolation worktree is rejected");
  }

  const originalCwd = active.originalCwd;
  const worktreePath = active.activePath;
  const worktreeBranch = active.managedBranch;

  if (opts.action === "keep") {
    await applyExitKeep(ctx, active);
    return {
      action: "keep",
      originalCwd,
      worktreePath,
      ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
      message: `Left worktree at ${worktreePath} (kept on disk); cwd restored to ${originalCwd}`,
    };
  }

  // action === "remove"
  if (active.ownership === "enteredExisting" && worktreeBranch === undefined) {
    // Still allow remove of entered paths that are session-managed; reject bare foreign
    // agent trees (already handled). Force-remove only when discardChanges or clean.
  }

  const discard = opts.discardChanges === true;
  let discardedFiles = 0;
  let discardedCommits = 0;

  if (discard) {
    const dirty = await countDirtyPaths(worktreePath);
    discardedFiles = dirty.files;
    discardedCommits = dirty.commitsAhead;
  } else {
    const pristine = await isWorktreePristine(worktreePath, active.baseSha);
    if (!pristine) {
      throw new Error(
        `session worktree: ${worktreePath} has local changes; pass discardChanges to force remove`,
      );
    }
  }

  const config = loadConfigSync();
  await fireWorktreeRemoveHooks(config, worktreePath);

  const repoRoot = (await canonicalGitRoot(originalCwd)) ?? (await canonicalGitRoot(worktreePath));
  if (repoRoot !== null) {
    const removeArgs = discard
      ? ["worktree", "remove", "--force", worktreePath]
      : ["worktree", "remove", worktreePath];
    const removed = await git(repoRoot, removeArgs);
    if (!removed.ok && discard) {
      await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
      await git(repoRoot, ["worktree", "prune"]);
    } else if (!removed.ok) {
      throw new Error(`session worktree: git worktree remove failed for ${worktreePath}`);
    }
    if (worktreeBranch !== undefined && isSessionManagedBranch(worktreeBranch)) {
      await git(repoRoot, ["branch", "-D", worktreeBranch]);
    }
  } else {
    await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
  }

  clearActive(ctx);
  setActiveCwd(ctx, originalCwd, null);

  return {
    action: "remove",
    originalCwd,
    worktreePath,
    ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
    ...(discard ? { discardedFiles, discardedCommits } : {}),
    message: `Removed worktree at ${worktreePath}; cwd restored to ${originalCwd}`,
  };
}

/**
 * Persistable stamp fragment for the session sidecar / transcript lines.
 */
export function worktreeStampOf(session: Session): SessionWorktreeStamp | undefined {
  const wt = session.worktree;
  if (wt === null) return undefined;
  return {
    originalCwd: wt.originalCwd,
    activePath: wt.activePath,
    ownership: wt.ownership,
    ...(wt.managedBranch !== undefined ? { managedBranch: wt.managedBranch } : {}),
    ...(wt.baseSha !== undefined ? { baseSha: wt.baseSha } : {}),
    ...(wt.tmuxSession !== undefined ? { tmuxSession: wt.tmuxSession } : {}),
  };
}

/**
 * On resume: restore active worktree only if still a registered worktree of the
 * recorded repo; otherwise stay at storageCwd with a non-destructive warning.
 */
export async function restoreSessionWorktreeOnResume(
  session: Session,
  recorded: SessionWorktreeStamp | null | undefined,
): Promise<{ restored: boolean; warning?: string }> {
  attachSessionWorktreeHost(session);
  if (recorded === null || recorded === undefined) {
    session.worktree = null;
    session.cwd = session.storageCwd;
    return { restored: false };
  }

  const repoRoot = await canonicalGitRoot(recorded.originalCwd || session.storageCwd);
  if (repoRoot === null) {
    session.worktree = null;
    session.cwd = session.storageCwd;
    return {
      restored: false,
      warning: `session worktree: recorded repo unavailable; staying at ${session.storageCwd}`,
    };
  }

  const registered = await worktreePathsForAsync(repoRoot);
  const active = resolve(recorded.activePath);
  const isRegistered = registered.some((p) => resolve(p) === active);
  if (!isRegistered || !(await pathExists(active))) {
    session.worktree = null;
    session.cwd = session.storageCwd;
    return {
      restored: false,
      warning: `session worktree: ${active} is no longer a registered worktree; staying at ${session.storageCwd}`,
    };
  }

  if (await isAgentIsolationWorktree(active)) {
    session.worktree = null;
    session.cwd = session.storageCwd;
    return {
      restored: false,
      warning: `session worktree: refusing to restore Agent-isolation path ${active}`,
    };
  }

  session.worktree = {
    originalCwd: recorded.originalCwd || session.storageCwd,
    activePath: active,
    ownership: recorded.ownership,
    ...(recorded.managedBranch !== undefined ? { managedBranch: recorded.managedBranch } : {}),
    ...(recorded.baseSha !== undefined ? { baseSha: recorded.baseSha } : {}),
    ...(recorded.tmuxSession !== undefined ? { tmuxSession: recorded.tmuxSession } : {}),
  };
  session.cwd = active;
  return { restored: true };
}

/** Scan newest-to-oldest transcript lines for a worktree stamp on the envelope. */
export async function readWorktreeStampFromSessionFile(
  storageCwd: string,
  sessionId: string,
): Promise<SessionWorktreeStamp | null> {
  const path = sessionPathForCwd(storageCwd, sessionId);
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const text = await file.text();
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line || line.length === 0) continue;
      try {
        const env = JSON.parse(line) as Record<string, unknown>;
        const stamp = parseWorktreeStamp(env.worktree);
        if (stamp !== null) return stamp;
      } catch {
        // skip corrupt lines
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function parseWorktreeStamp(value: unknown): SessionWorktreeStamp | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.activePath !== "string" || obj.activePath.length === 0) return null;
  if (typeof obj.originalCwd !== "string" || obj.originalCwd.length === 0) return null;
  if (obj.ownership !== "created" && obj.ownership !== "enteredExisting") return null;
  const stamp: SessionWorktreeStamp = {
    originalCwd: obj.originalCwd,
    activePath: obj.activePath,
    ownership: obj.ownership,
  };
  if (typeof obj.managedBranch === "string" && obj.managedBranch.length > 0) {
    stamp.managedBranch = obj.managedBranch;
  }
  if (typeof obj.baseSha === "string" && obj.baseSha.length > 0) stamp.baseSha = obj.baseSha;
  if (typeof obj.tmuxSession === "string" && obj.tmuxSession.length > 0) {
    stamp.tmuxSession = obj.tmuxSession;
  }
  return stamp;
}

export function flattenWorktreeName(name: string): string {
  return name.replaceAll("/", "+");
}

export function isSessionManagedBranch(branch: string): boolean {
  return branch.startsWith(SESSION_BRANCH_PREFIX);
}

// ── internal ──────────────────────────────────────────────────────────────

function subagentControllerKey(ctx: RequestContext): string | null {
  if (typeof ctx.agentId === "string" && ctx.agentId.length > 0) {
    return `${ctx.sessionId}::${ctx.agentId}`;
  }
  return null;
}

function resolveStorageCwd(ctx: RequestContext): string {
  const host = liveHosts.get(ctx.sessionId);
  if (host) return host.storageCwd;
  return ctx.originalCwd ?? ctx.cwd;
}

function applyEnter(ctx: RequestContext, state: SessionWorktreeState): void {
  const subKey = subagentControllerKey(ctx);
  if (subKey !== null) {
    subagentControllers.set(subKey, state);
    ctx.originalCwd = ctx.originalCwd ?? state.originalCwd;
    ctx.cwd = state.activePath;
    ctx.worktreeRoot = state.activePath;
    return;
  }
  const host = liveHosts.get(ctx.sessionId);
  if (host) {
    host.worktree = state;
    host.cwd = state.activePath;
  }
  ctx.originalCwd = state.originalCwd;
  ctx.cwd = state.activePath;
  ctx.worktreeRoot = state.activePath;
}

async function applyExitKeep(ctx: RequestContext, active: SessionWorktreeState): Promise<void> {
  clearActive(ctx);
  setActiveCwd(ctx, active.originalCwd, null);
}

function clearActive(ctx: RequestContext): void {
  const subKey = subagentControllerKey(ctx);
  if (subKey !== null) {
    subagentControllers.delete(subKey);
    return;
  }
  const host = liveHosts.get(ctx.sessionId);
  if (host) host.worktree = null;
}

function setActiveCwd(ctx: RequestContext, cwd: string, worktreeRoot: string | null): void {
  ctx.cwd = cwd;
  if (worktreeRoot === null) {
    delete ctx.worktreeRoot;
  } else {
    ctx.worktreeRoot = worktreeRoot;
  }
  const subKey = subagentControllerKey(ctx);
  if (subKey !== null) return;
  const host = liveHosts.get(ctx.sessionId);
  if (host) host.cwd = cwd;
}

function sanitizeWorktreeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return autoWorktreeName();
  return trimmed.replace(/[^\w.@/+-]+/g, "-").replace(/^-+|-+$/g, "") || autoWorktreeName();
}

function autoWorktreeName(): string {
  return `session-${randomUUID().slice(0, 8)}`;
}

async function firstNonemptyHookPath(config: UserConfig, name: string): Promise<string | null> {
  try {
    const outcomes = await fireWorktreeCreateHooks(config, name);
    for (const outcome of outcomes) {
      if (outcome.kind !== "ok") continue;
      for (const line of outcome.stdout.split("\n")) {
        const path = line.trim();
        if (path.length > 0) return path;
      }
    }
  } catch {
    // Hooks are best-effort; fall through to default creation.
  }
  return null;
}

async function resolveBaseRef(repoRoot: string, config: UserConfig): Promise<string> {
  const setting = config.worktree?.baseRef ?? "fresh";
  if (setting === "head") {
    return "HEAD";
  }
  // fresh: origin/<default-branch>, safe HEAD fallback
  const originHead = await git(repoRoot, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  if (originHead.ok) {
    const ref = originHead.stdout.trim(); // e.g. origin/main
    if (ref.length > 0 && ref !== "origin/HEAD") {
      const ok = await revParse(repoRoot, ref);
      if (ok !== null) return ref;
    }
  }
  for (const candidate of ["origin/main", "origin/master"]) {
    if ((await revParse(repoRoot, candidate)) !== null) return candidate;
  }
  return "HEAD";
}

async function assertRegisteredWorktree(repoRoot: string, path: string): Promise<void> {
  const registered = await worktreePathsForAsync(repoRoot);
  const target = resolve(path);
  if (!registered.some((p) => resolve(p) === target)) {
    // Also accept if path itself reports the same common git dir.
    const root = await canonicalGitRoot(path);
    if (root === null || resolve(root) !== resolve(repoRoot)) {
      throw new Error(`session worktree: ${path} is not a registered worktree of ${repoRoot}`);
    }
  }
}

async function isAgentIsolationWorktree(path: string): Promise<boolean> {
  const branch = await currentBranch(path);
  return branch?.startsWith(AGENT_ISOLATION_BRANCH_PREFIX) === true;
}

async function isWorktreePristine(path: string, baseSha?: string): Promise<boolean> {
  const dirty = await git(path, ["status", "--porcelain"]);
  if (!dirty.ok) return false;
  if (dirty.stdout.trim().length > 0) return false;
  if (baseSha) {
    const head = await revParse(path, "HEAD");
    if (head !== null && head !== baseSha) {
      // Commits ahead of base count as non-pristine for non-discard remove.
      const ahead = await git(path, ["rev-list", "--count", `${baseSha}..HEAD`]);
      if (ahead.ok && Number.parseInt(ahead.stdout.trim(), 10) > 0) return false;
    }
  }
  return true;
}

async function countDirtyPaths(path: string): Promise<{ files: number; commitsAhead: number }> {
  const status = await git(path, ["status", "--porcelain"]);
  const files = status.ok ? status.stdout.split("\n").filter((l) => l.trim().length > 0).length : 0;
  // Best-effort commits ahead of upstream / base.
  const ahead = await git(path, ["rev-list", "--count", "@{upstream}..HEAD"]);
  const commitsAhead =
    ahead.ok && ahead.stdout.trim().length > 0 ? Number.parseInt(ahead.stdout.trim(), 10) || 0 : 0;
  return { files, commitsAhead };
}

async function currentBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!r.ok) return null;
  const b = r.stdout.trim();
  return b.length > 0 ? b : null;
}

async function revParse(cwd: string, ref: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", ref]);
  if (!r.ok) return null;
  const sha = r.stdout.trim();
  return sha.length > 0 ? sha : null;
}

async function canonicalGitRoot(cwd: string): Promise<string | null> {
  const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) return null;
  const dir = common.stdout.trim();
  return dir.length > 0 ? dirname(dir) : null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return { ok: code === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}
