import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { matchesBaseline, readBaseline, type WorktreeBaseline } from "./worktree-baseline.ts";
import { pathExists, removeDirRobust } from "./worktree-filesystem.ts";
import { activeWorktreeRoot, canonicalGitRoot, git } from "./worktree-git.ts";
import { isWorktreeLeaseLive } from "./worktree-lease.ts";
import { withWorktreeLock } from "./worktree-lock.ts";
import { assessNestedRepos } from "./worktree-nested-repos.ts";

export interface Worktree {
  path: string;
  branch: string;
  warning?: string;
  cleanup: () => Promise<{ deleted: boolean }>;
}

const ORPHAN_SLUG_PATTERN = /^(fork_[0-9a-z]+_[0-9a-z]+|workflow-[a-zA-Z0-9_-]+)$/;

let cleanupValidationHook: (() => void | Promise<void>) | null = null;
let cleanupRemovalHook: ((quarantinePath: string) => void | Promise<void>) | null = null;

export function setWorktreeCleanupValidationHookForTests(
  hook: (() => void | Promise<void>) | null,
): void {
  cleanupValidationHook = hook;
}

export function setWorktreeCleanupRemovalHookForTests(
  hook: ((quarantinePath: string) => void | Promise<void>) | null,
): void {
  cleanupRemovalHook = hook;
}

let quarantineSeq = 0;

async function restoreQuarantinedWorktree(
  repoRoot: string,
  quarantinePath: string,
  path: string,
  baseline: WorktreeBaseline,
): Promise<void> {
  await git(quarantinePath, ["reset", "--mixed", baseline.head]);
  await git(repoRoot, ["worktree", "move", quarantinePath, path]);
}

async function sealWorktreeForRemoval(
  path: string,
  branch: string,
  baseline: WorktreeBaseline,
): Promise<boolean> {
  const staged = await git(path, ["add", "-A", "--", "."]);
  if (!staged.ok) return false;
  const tree = await git(path, ["write-tree"]);
  if (!tree.ok || tree.stdout.trim() !== baseline.tree) return false;
  const commit = await git(path, [
    "-c",
    "user.name=Otherside",
    "-c",
    "user.email=worktree@localhost",
    "commit-tree",
    tree.stdout.trim(),
    "-p",
    baseline.head,
    "-m",
    "Temporary worktree cleanup seal",
  ]);
  if (!commit.ok || commit.stdout.trim().length === 0) return false;
  return (
    await git(path, ["update-ref", `refs/heads/${branch}`, commit.stdout.trim(), baseline.head])
  ).ok;
}

async function removeWorktree(
  repoRoot: string,
  path: string,
  branch: string,
  baseline: WorktreeBaseline,
): Promise<boolean> {
  await cleanupValidationHook?.();
  // Fail closed: never tear down a worktree another live run still holds a lease
  // on. The owning run releases its own lease before cleanup, so this only trips
  // for a foreign live holder (e.g. the pruner racing a just-started agent).
  if (await isWorktreeLeaseLive(path)) return false;
  if (!(await matchesBaseline(path, baseline))) return false;
  // Nested repos are invisible to the baseline: the source repo gitignores its
  // child repos, the fingerprint honors those excludes, and even a visible
  // directory hashes without its interior. Any nested repo found in the area is
  // agent-authored work the fingerprint cannot vouch for — fail closed unless
  // every one is a clean linked worktree whose commits live in its owner repo.
  const nestedRepos = await assessNestedRepos(path);
  if (nestedRepos.kind === "blocked") return false;
  quarantineSeq += 1;
  const quarantinePath = `${path}.removing-${process.pid}-${quarantineSeq}`;
  const moved = await git(repoRoot, ["worktree", "move", path, quarantinePath]);
  if (!moved.ok) return false;
  if (
    !(await matchesBaseline(quarantinePath, baseline)) ||
    !(await sealWorktreeForRemoval(quarantinePath, branch, baseline))
  ) {
    await restoreQuarantinedWorktree(repoRoot, quarantinePath, path, baseline);
    return false;
  }
  await cleanupRemovalHook?.(quarantinePath);
  // Prefer git's non-force removal so a post-seal write (race) is preserved.
  // On Windows, long-path leftovers or briefly locked files can make remove fail
  // even when the tree is still baseline-identical — only then fall back to
  // --force / filesystem delete. Never force-delete when the tree drifted
  // (valuable agent work must survive). Compare write-tree to baseline.tree
  // (not the fingerprint): seal advances HEAD, which would make a fingerprint
  // recheck look "dirty" even when the working tree is unchanged.
  let removed = await git(repoRoot, ["worktree", "remove", quarantinePath]);
  if (!removed.ok) {
    const staged = await git(quarantinePath, ["add", "-A", "--", "."]);
    const tree = staged.ok ? await git(quarantinePath, ["write-tree"]) : { ok: false, stdout: "" };
    const contentUnchanged = tree.ok && tree.stdout.trim() === baseline.tree;
    if (!contentUnchanged) {
      await restoreQuarantinedWorktree(repoRoot, quarantinePath, path, baseline);
      return false;
    }
    removed = await git(repoRoot, ["worktree", "remove", "--force", quarantinePath]);
    if (!removed.ok) {
      await removeDirRobust(quarantinePath);
      await git(repoRoot, ["worktree", "prune"]);
    }
    if ((await pathExists(quarantinePath)) || (await pathExists(path))) {
      if (await pathExists(quarantinePath)) {
        await restoreQuarantinedWorktree(repoRoot, quarantinePath, path, baseline);
      }
      return false;
    }
  }
  // The area is gone; the owner repos of any linked nested worktrees still
  // register the deleted paths as prunable metadata — drop it (best-effort).
  for (const ownerRepo of nestedRepos.ownerRepos) {
    await git(ownerRepo, ["worktree", "prune"]);
  }
  return (await git(repoRoot, ["branch", "-D", branch])).ok;
}

async function tryPruneOne(opts: {
  repoRoot: string;
  worktreesDir: string;
  slug: string;
  cutoff: number;
  activeWorktree: string | null;
}): Promise<boolean> {
  const wtPath = join(opts.worktreesDir, opts.slug);
  if (opts.activeWorktree !== null && resolve(wtPath) === opts.activeWorktree) return false;
  try {
    const info = await stat(wtPath);
    if (info.mtimeMs >= opts.cutoff) return false;
  } catch {
    return false;
  }
  // A live run holds a lease for its whole lifetime — never reclaim it even if
  // the directory mtime aged past the cutoff.
  if (await isWorktreeLeaseLive(wtPath)) return false;
  const baseline = await readBaseline(wtPath);
  if (baseline === null || !(await matchesBaseline(wtPath, baseline))) return false;
  return withWorktreeLock(wtPath, () =>
    removeWorktree(opts.repoRoot, wtPath, `otherside/agent/${opts.slug}`, baseline),
  );
}

export async function pruneOrphanWorktrees(opts: { cwd: string; cutoff: number }): Promise<number> {
  const repoRoot = await canonicalGitRoot(opts.cwd);
  if (repoRoot === null) return 0;
  const activeWorktree = await activeWorktreeRoot(opts.cwd);
  const worktreesDir = join(repoRoot, ".otherside", "worktrees");
  let entries: string[];
  try {
    entries = await readdir(worktreesDir);
  } catch {
    return 0;
  }
  const slugs = entries.filter((name) => ORPHAN_SLUG_PATTERN.test(name));
  const results = await Promise.all(
    slugs.map((slug) =>
      tryPruneOne({ repoRoot, worktreesDir, slug, cutoff: opts.cutoff, activeWorktree }),
    ),
  );
  const removed = results.filter(Boolean).length;
  if (removed > 0) await git(repoRoot, ["worktree", "prune"]);
  return removed;
}

export function worktreeHandle(input: {
  path: string;
  branch: string;
  repoRoot: string;
  baseline: WorktreeBaseline | null;
  warning?: string;
}): Worktree {
  const { path, branch, repoRoot, baseline, warning } = input;
  return {
    path,
    branch,
    ...(warning !== undefined ? { warning } : {}),
    async cleanup() {
      if (baseline === null || !(await matchesBaseline(path, baseline))) {
        return { deleted: false };
      }
      return {
        deleted: await withWorktreeLock(path, () =>
          removeWorktree(repoRoot, path, branch, baseline),
        ),
      };
    },
  };
}

export async function rollbackWorktreeCreation(
  repoRoot: string,
  path: string,
  branch: string,
): Promise<void> {
  await git(repoRoot, ["worktree", "remove", "--force", path]);
  await git(repoRoot, ["branch", "-D", branch]);
  await removeDirRobust(path);
  await git(repoRoot, ["worktree", "prune"]);
}
