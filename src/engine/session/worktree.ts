import { realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename } from "node:path";
import { resolveConfig } from "@/kernel/config/resolver.ts";
import { fireWorktreeRemoveHooks } from "@/kernel/hooks/handler.ts";
import { canonicalizeCwd } from "@/kernel/std/fs/paths.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { createSessionWorktree } from "./worktree-creation.ts";
import { canonicalGitRoot, git } from "./worktree-git.ts";
import { isSessionManagedBranch } from "./worktree-naming.ts";
import { pathExists, samePath } from "./worktree-path.ts";
import { clearProjectWorktreeSlot, persistProjectWorktreeSlot } from "./worktree-persistence.ts";
import { mayRemoveSessionWorktree, releaseSessionWorktreeLock } from "./worktree-registry.ts";
import {
  applyEnter,
  clearActive,
  clearLatchedWorktreeName,
  climbToExistingDirectory,
  getActiveWorktree,
  isAgentContext,
  isPinnedCwdContext,
  relocateHostTranscript,
  resolveStorageCwd,
  setActiveCwd,
  subagentControllerKey,
} from "./worktree-runtime.ts";
import type { SessionWorktreeState } from "./worktree-state.ts";
import { resolveManagedSessionWorktreePath, resolveWorktreeTargetPath } from "./worktree-target.ts";

export {
  flattenWorktreeName,
  isSessionManagedBranch,
  parsePRReference,
  worktreeTmuxSessionName,
} from "./worktree-naming.ts";
export {
  clearProjectWorktreeSlot,
  persistProjectWorktreeSlot,
  readProjectWorktreeSlot,
  restoreSessionWorktreeOnResume,
  stampedWorktreeStateFrom,
} from "./worktree-persistence.ts";
export {
  attachSessionWorktreeHost,
  clearLatchedWorktreeName,
  detachSessionWorktreeHost,
  getActiveWorktree,
  isAgentContext,
  isPinnedCwdContext,
  latchedWorktreeName,
} from "./worktree-runtime.ts";
export type { SessionWorktreeState } from "./worktree-state.ts";
export {
  resolveManagedSessionWorktreePath,
  resolveWorktreeLaunchBase,
} from "./worktree-target.ts";

export async function enterSessionWorktree(
  ctx: RequestContext,
  opts: { name?: string; path?: string; prNumber?: number; tmuxSessionName?: string },
): Promise<{ worktreePath: string; worktreeBranch?: string; message: string }> {
  const existing = getActiveWorktree(ctx);
  const pathInput = typeof opts.path === "string" && opts.path.length > 0 ? opts.path : undefined;
  if (existing !== null && pathInput === undefined) {
    throw new Error(
      "Already in a worktree session. Pass `path` to switch into another existing worktree, or use ExitWorktree to leave this one before creating a new worktree.",
    );
  }

  const originalCwd = existing?.originalCwd ?? ctx.cwd;
  const preEnterOriginalCwd =
    existing?.preEnterOriginalCwd ?? ctx.originalCwd ?? resolveStorageCwd(ctx);

  if (pathInput !== undefined) {
    return enterExistingWorktree(ctx, existing, {
      originalCwd,
      preEnterOriginalCwd,
      pathInput,
    });
  }

  if (isAgentContext(ctx)) {
    throw new Error(
      "EnterWorktree cannot create a worktree from a subagent. To switch this agent into an existing managed worktree (under .otherside/worktrees/ of this repository), call EnterWorktree with `path`. To work in any other directory, spawn an Agent with `cwd` set to it.",
    );
  }

  const created = await createSessionWorktree({
    ctx,
    originalCwd,
    preEnterOriginalCwd,
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.prNumber !== undefined ? { prNumber: opts.prNumber } : {}),
    ...(opts.tmuxSessionName !== undefined ? { tmuxSessionName: opts.tmuxSessionName } : {}),
  });
  applyEnter(ctx, created.state);
  await finalizeMainSessionEnter(ctx, created.state);
  return created.result;
}

interface ExistingWorktreeEntry {
  originalCwd: string;
  preEnterOriginalCwd: string;
  pathInput: string;
}

async function enterExistingWorktree(
  ctx: RequestContext,
  existing: SessionWorktreeState | null,
  entry: ExistingWorktreeEntry,
): Promise<{ worktreePath: string; worktreeBranch?: string; message: string }> {
  const requireManagedLocation = isAgentContext(ctx)
    ? true
    : (await resolveManagedSessionWorktreePath(ctx.cwd, entry.pathInput)) !== null;
  const target = await resolveWorktreeTargetPath(ctx.cwd, entry.pathInput, {
    requireManagedLocation,
    requireCwdInsideRepo: isPinnedCwdContext(ctx),
  });
  if (existing !== null && !existing.hookBased && existing.ownership === "created") {
    await releaseSessionWorktreeLock(existing);
  }
  const state: SessionWorktreeState = {
    originalCwd: entry.originalCwd,
    preEnterOriginalCwd: entry.preEnterOriginalCwd,
    activePath: target.worktreePath,
    worktreeName: basename(target.worktreePath),
    ownership: "enteredExisting",
    ownerRepoRoot: target.ownerRepoRoot,
    ...(target.nestedRepoRoot !== undefined ? { nestedRepoRoot: target.nestedRepoRoot } : {}),
    ...(target.worktreeBranch !== undefined ? { managedBranch: target.worktreeBranch } : {}),
  };
  applyEnter(ctx, state);
  await finalizeMainSessionEnter(ctx, state);
  const branchInfo = target.worktreeBranch ? ` on branch ${target.worktreeBranch}` : "";
  const message = isPinnedCwdContext(ctx)
    ? `Entered worktree at ${target.worktreePath}${branchInfo}. This agent's working directory and write access now point at the worktree; the previous directory was left untouched.`
    : `Entered worktree at ${target.worktreePath}${branchInfo}. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`;
  return {
    worktreePath: target.worktreePath,
    ...(target.worktreeBranch !== undefined ? { worktreeBranch: target.worktreeBranch } : {}),
    message,
  };
}

export async function exitSessionWorktree(
  ctx: RequestContext,
  opts: {
    action: "keep" | "remove";
    discardChanges?: boolean;
    /**
     * Cwd recovery when the original directory is gone: the tool path falls
     * back worktree → home → tmp; the session-end path climbs the original
     * directory's parent chain instead.
     */
    restoreStrategy?: "tool" | "parent-chain";
  },
): Promise<{
  action: "keep" | "remove";
  originalCwd: string;
  restoredCwd: string;
  worktreePath?: string;
  worktreeBranch?: string;
  discardedFiles?: number;
  discardedCommits?: number;
  message: string;
}> {
  if (isAgentContext(ctx)) {
    throw new Error(
      "ExitWorktree cannot be called from a subagent — this agent is already isolated; use Bash with `cd` for directory changes within it.",
    );
  }
  const active = getActiveWorktree(ctx);
  if (active === null) throw new Error("Not in a worktree session");

  const originalCwd = active.originalCwd;
  const worktreePath = active.activePath;
  const worktreeBranch = active.managedBranch;
  const restore =
    opts.restoreStrategy === "parent-chain"
      ? (from: string) => climbToExistingDirectory(from)
      : (from: string) => restoreAfterWorktreeExit(from, worktreePath);
  const restoreStrategy = opts.restoreStrategy === "parent-chain" ? "parent-chain" : "tool";

  if (opts.action === "keep") {
    await releaseSessionWorktreeLock(active);
    const restoredCwd = await restore(originalCwd);
    clearActive(ctx);
    setActiveCwd(ctx, restoredCwd, null);
    await finalizeMainSessionExit(ctx, active, restoredCwd, restoreStrategy);
    return {
      action: "keep",
      originalCwd,
      restoredCwd,
      worktreePath,
      ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
      message: `Left worktree at ${worktreePath} (kept on disk); cwd restored to ${restoredCwd}`,
    };
  }

  if (active.ownership === "enteredExisting") {
    throw new Error(`This session does not own the worktree at ${worktreePath}`);
  }
  clearLatchedWorktreeName();
  const dirty = await countDirtyPaths(worktreePath, active.baseSha);
  if (
    opts.discardChanges !== true &&
    (dirty.files > 0 || dirty.commitsAhead > 0 || dirty.gitError)
  ) {
    throw new Error(
      `${worktreePath} has local changes or could not be verified; pass discardChanges to force remove`,
    );
  }

  const removed = await removeSessionWorktree(active, originalCwd);
  const restoredCwd = await restore(originalCwd);
  clearActive(ctx);
  setActiveCwd(ctx, restoredCwd, null);
  await finalizeMainSessionExit(ctx, active, restoredCwd, restoreStrategy);
  if (!removed) {
    return {
      action: "keep",
      originalCwd,
      restoredCwd,
      worktreePath,
      ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
      discardedFiles: 0,
      discardedCommits: 0,
      message: `Worktree cleanup failed; kept at ${worktreePath}`,
    };
  }
  return {
    action: "remove",
    originalCwd,
    restoredCwd,
    worktreePath,
    ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
    discardedFiles: dirty.files,
    discardedCommits: dirty.commitsAhead,
    message: `Removed worktree at ${worktreePath}; cwd restored to ${restoredCwd}`,
  };
}

async function removeSessionWorktree(
  active: SessionWorktreeState,
  originalCwd: string,
): Promise<boolean> {
  if (active.hookBased) {
    try {
      await fireWorktreeRemoveHooks(resolveConfig(originalCwd), active.activePath);
      return !(await pathExists(active.activePath));
    } catch {
      return false;
    }
  }
  const repoRoot =
    active.ownerRepoRoot ??
    (await canonicalGitRoot(originalCwd)) ??
    (await canonicalGitRoot(active.activePath));
  if (repoRoot === null || !(await mayRemoveSessionWorktree(active, repoRoot))) return false;
  await git(repoRoot, ["worktree", "unlock", active.activePath]);
  const result = await git(repoRoot, ["worktree", "remove", "--force", active.activePath]);
  const removed = result.ok || !(await pathExists(active.activePath));
  if (
    removed &&
    active.managedBranch !== undefined &&
    isSessionManagedBranch(active.managedBranch)
  ) {
    await git(repoRoot, ["branch", "-D", active.managedBranch]);
  }
  return removed;
}

async function finalizeMainSessionEnter(
  ctx: RequestContext,
  state: SessionWorktreeState,
): Promise<void> {
  if (subagentControllerKey(ctx) !== null) return;
  if (!state.hookBased && state.nestedRepoRoot === undefined) {
    await relocateHostTranscript(ctx.sessionId, state.activePath);
  }
  await persistProjectWorktreeSlot(state, ctx.sessionId);
}

async function finalizeMainSessionExit(
  ctx: RequestContext,
  active: SessionWorktreeState,
  restoredCwd: string,
  strategy: "tool" | "parent-chain",
): Promise<void> {
  if (subagentControllerKey(ctx) !== null) return;
  await clearProjectWorktreeSlot(ctx.sessionId);
  const restoredToOriginal = samePath(
    canonicalizeCwd(restoredCwd),
    canonicalizeCwd(active.originalCwd),
  );
  if (restoredToOriginal) {
    await relocateHostTranscript(ctx.sessionId, active.preEnterOriginalCwd ?? restoredCwd);
    return;
  }
  if (
    strategy === "tool" &&
    samePath(canonicalizeCwd(restoredCwd), canonicalizeCwd(active.activePath))
  ) {
    await relocateHostTranscript(ctx.sessionId, restoredCwd);
  }
}

async function restoreAfterWorktreeExit(
  originalCwd: string,
  worktreePath: string,
): Promise<string> {
  const candidates = [
    originalCwd,
    worktreePath,
    homedir(),
    process.env.OTHERSIDE_TMPDIR ?? process.env.CLAUDE_CODE_TMPDIR ?? tmpdir(),
  ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory()) return await realpath(candidate);
    } catch {}
  }
  return originalCwd;
}

async function countDirtyPaths(
  path: string,
  baseSha: string | undefined,
): Promise<{ files: number; commitsAhead: number; gitError: boolean }> {
  const status = await git(path, ["status", "--porcelain"]);
  if (!status.ok) return { files: 0, commitsAhead: 0, gitError: true };
  const files = status.stdout.split("\n").filter((line) => line.trim().length > 0).length;
  if (baseSha === undefined) return { files, commitsAhead: 0, gitError: true };
  const ahead = await git(path, ["rev-list", "--count", `${baseSha}..HEAD`]);
  if (!ahead.ok) return { files, commitsAhead: 0, gitError: true };
  const commitsAhead = Number.parseInt(ahead.stdout.trim(), 10) || 0;
  return { files, commitsAhead, gitError: false };
}
