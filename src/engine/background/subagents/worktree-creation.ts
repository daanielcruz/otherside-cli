import { lstat, mkdir, realpath, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BASELINE_VERSION,
  calculateFingerprint,
  readBaseline,
  snapshotWorktreeTree,
  type WorktreeBaseline,
  writeBaseline,
} from "./worktree-baseline.ts";
import { activeWorktreeRoot, canonicalGitRoot, git } from "./worktree-git.ts";
import { withWorktreeLock } from "./worktree-lock.ts";
import { findNestedRepos } from "./worktree-nested-repos.ts";
import { replicateDirtyChanges } from "./worktree-overlay.ts";
import { isPathWithinRoot } from "./worktree-path.ts";
import { rollbackWorktreeCreation, type Worktree, worktreeHandle } from "./worktree-removal.ts";

function worktreeSlug(agentId: string): string {
  return agentId.replace(/[^a-zA-Z0-9_-]/g, "-");
}

async function existingWorktreeMatches(
  path: string,
  branch: string,
  commonRepoRoot: string,
): Promise<boolean> {
  const [root, currentBranch] = await Promise.all([
    canonicalGitRoot(path),
    git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
  ]);
  return root === commonRepoRoot && currentBranch.ok && currentBranch.stdout.trim() === branch;
}

export async function createWorktree(cwd: string, agentId: string): Promise<Worktree | null> {
  const commonRepoRoot = await canonicalGitRoot(cwd);
  if (commonRepoRoot === null) return null;
  const slug = worktreeSlug(agentId);
  const key = join(commonRepoRoot, ".otherside", "worktrees", slug);
  return withWorktreeLock(key, () => createWorktreeLocked(cwd, slug, commonRepoRoot));
}

async function createWorktreeLocked(
  cwd: string,
  slug: string,
  commonRepoRoot: string,
): Promise<Worktree | null> {
  const activeSourceRoot = await activeWorktreeRoot(cwd);
  if (activeSourceRoot === null) return null;
  const cwdReal = await realpath(cwd);
  const activeSourceRootReal = await realpath(activeSourceRoot);
  if (!isPathWithinRoot(activeSourceRootReal, cwdReal)) {
    throw new Error(
      `worktree isolation: cwd ${cwdReal} is outside the resolved repo ${activeSourceRootReal}`,
    );
  }

  const nestedRepos = await findNestedRepos(activeSourceRoot);
  const warning =
    nestedRepos.length > 0
      ? `nested repos are NOT materialized: ${nestedRepos.join(", ")}`
      : undefined;
  const path = join(commonRepoRoot, ".otherside", "worktrees", slug);
  const branch = `otherside/agent/${slug}`;

  try {
    const existing = await lstat(path);
    if (
      existing.isSymbolicLink() ||
      !(await existingWorktreeMatches(path, branch, commonRepoRoot))
    ) {
      throw new Error(
        `worktree isolation: existing path is not the expected linked worktree: ${path}`,
      );
    }
    const baseline = await readBaseline(path);
    try {
      const now = new Date();
      await utimes(path, now, now);
    } catch {}
    return worktreeHandle({
      path,
      branch,
      repoRoot: commonRepoRoot,
      baseline,
      ...(warning !== undefined ? { warning } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("worktree isolation:")) throw error;
  }

  await mkdir(dirname(path), { recursive: true });
  const sourceHead = await git(activeSourceRoot, ["rev-parse", "HEAD"]);
  if (!sourceHead.ok || sourceHead.stdout.trim().length === 0) return null;
  const added = await git(commonRepoRoot, [
    "worktree",
    "add",
    "-B",
    branch,
    path,
    sourceHead.stdout.trim(),
  ]);
  if (!added.ok) return null;

  // The linked worktree now physically exists. Any setup failure past this point
  // must roll it back so a torn overlay never survives as a reusable worktree —
  // a published baseline is the creation's completion marker.
  try {
    await replicateDirtyChanges(activeSourceRoot, path, nestedRepos);
    const head = await git(path, ["rev-parse", "HEAD"]);
    const fingerprint = await calculateFingerprint(path);
    const tree = await snapshotWorktreeTree(path);
    const baseline: WorktreeBaseline | null =
      head.ok && head.stdout.trim().length > 0 && fingerprint !== null && tree !== null
        ? {
            version: BASELINE_VERSION,
            head: head.stdout.trim(),
            fingerprint,
            tree,
          }
        : null;
    if (baseline === null || !(await writeBaseline(path, baseline))) {
      throw new Error("worktree isolation: failed to establish the worktree baseline");
    }
    return worktreeHandle({
      path,
      branch,
      repoRoot: commonRepoRoot,
      baseline,
      ...(warning !== undefined ? { warning } : {}),
    });
  } catch (error) {
    await rollbackWorktreeCreation(commonRepoRoot, path, branch);
    throw error;
  }
}
