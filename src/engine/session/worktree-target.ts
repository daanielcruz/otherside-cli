import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalGitRoot, git } from "./worktree-git.ts";
import { isNetworkWorktreePath, pathInside, samePath } from "./worktree-path.ts";
import { isLiveForeignSessionLock, listSessionWorktrees } from "./worktree-registry.ts";

/**
 * Launch-time base directory for `--worktree`: a session started inside a
 * linked worktree anchors on the main repository root instead (matching the
 * launch flag semantics of resolving to the main checkout); a non-repo cwd is
 * reported so the caller can gate the flag.
 */
export async function resolveWorktreeLaunchBase(
  cwd: string,
): Promise<{ baseCwd: string; gitRepo: boolean }> {
  const root = await canonicalGitRoot(cwd);
  if (root === null) return { baseCwd: cwd, gitRepo: false };
  const gitDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const commonDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const linked =
    gitDir.ok &&
    commonDir.ok &&
    gitDir.stdout.trim().length > 0 &&
    !samePath(gitDir.stdout.trim(), commonDir.stdout.trim());
  return { baseCwd: linked ? root : cwd, gitRepo: true };
}

export async function resolveManagedSessionWorktreePath(
  cwd: string,
  path: string,
): Promise<string | null> {
  try {
    if (isNetworkWorktreePath(path)) return null;
    const repoRoot = await canonicalGitRoot(cwd);
    if (repoRoot === null) return null;
    const targetReal = await realpath(resolve(cwd, path));
    const rootReal = await realpath(repoRoot);
    const managedPath = join(rootReal, ".otherside", "worktrees");
    const managedReal = await realpath(managedPath);
    if (!samePath(managedPath, managedReal) || !pathInside(targetReal, managedReal)) return null;
    return targetReal;
  } catch {
    return null;
  }
}

export async function resolveWorktreeTargetPath(
  cwd: string,
  path: string,
  options: { requireManagedLocation: boolean; requireCwdInsideRepo: boolean },
): Promise<{
  worktreePath: string;
  worktreeBranch?: string;
  ownerRepoRoot: string;
  nestedRepoRoot?: string;
}> {
  if (isNetworkWorktreePath(path) || isNetworkWorktreePath(resolve(cwd, path))) {
    throw new Error(`Cannot enter worktree: ${path} is a network path.`);
  }
  const sourceRepoRoot = await canonicalGitRoot(cwd);
  if (sourceRepoRoot === null) {
    throw new Error(
      "Cannot enter an existing worktree: the current directory is not in a git repository.",
    );
  }

  let targetReal: string;
  let sourceRootReal: string;
  let sourceCwdReal: string;
  try {
    [targetReal, sourceRootReal, sourceCwdReal] = await Promise.all([
      realpath(resolve(cwd, path)),
      realpath(sourceRepoRoot),
      realpath(cwd),
    ]);
  } catch (error) {
    throw new Error(
      `Cannot enter worktree: ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (samePath(targetReal, sourceRootReal)) {
    throw new Error(
      `Cannot enter worktree: ${path} is the main working tree, not a linked worktree.`,
    );
  }
  if (samePath(targetReal, sourceCwdReal)) {
    throw new Error(`Cannot enter worktree: ${path} is the current working directory.`);
  }
  if (options.requireCwdInsideRepo && !pathInside(sourceCwdReal, sourceRootReal)) {
    throw new Error(
      `Cannot enter worktree: the current working directory ${cwd} is not inside the repository at ${sourceRepoRoot}.`,
    );
  }

  if (options.requireManagedLocation) {
    const managed = await resolveManagedSessionWorktreePath(cwd, path);
    if (managed === null || !samePath(managed, targetReal)) {
      throw new Error(
        `Cannot enter worktree: ${path} is not under ${join(sourceRootReal, ".otherside", "worktrees")}. Switching from this session is limited to worktrees managed by Otherside.`,
      );
    }
  }

  const targetRepoRoot = await canonicalGitRoot(targetReal);
  if (targetRepoRoot === null) {
    throw new Error(`Cannot enter worktree: ${path} is not in a git repository.`);
  }
  const ownerRepoRoot = await realpath(targetRepoRoot);
  const nested = !samePath(ownerRepoRoot, sourceRootReal);
  if (nested && (options.requireManagedLocation || !pathInside(ownerRepoRoot, sourceCwdReal))) {
    throw new Error(
      `Cannot enter worktree: ${path} belongs to repository ${ownerRepoRoot}, not ${sourceRepoRoot}.`,
    );
  }

  const registered = await listSessionWorktrees(ownerRepoRoot);
  const entry = registered.find((candidate) => samePath(candidate.worktreePath, targetReal));
  if (entry === undefined) {
    throw new Error(
      `Cannot enter worktree: ${path} is not a registered worktree of ${ownerRepoRoot}.`,
    );
  }
  if (entry.prunable) {
    throw new Error(`Cannot enter worktree: ${path} is marked prunable by git.`);
  }
  if (entry.lockReason !== undefined && isLiveForeignSessionLock(entry.lockReason)) {
    throw new Error(
      `Cannot enter worktree: ${path} belongs to another running Otherside session (locked: ${entry.lockReason}).`,
    );
  }

  return {
    worktreePath: targetReal,
    ownerRepoRoot,
    ...(entry.worktreeBranch !== undefined ? { worktreeBranch: entry.worktreeBranch } : {}),
    ...(nested ? { nestedRepoRoot: ownerRepoRoot } : {}),
  };
}
