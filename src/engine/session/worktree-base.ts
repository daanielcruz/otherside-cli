import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { UserConfig } from "@/kernel/config/config.ts";
import { currentBranch, git, revParse } from "./worktree-git.ts";
import { isLiveForeignSessionLock, lockReasonFor } from "./worktree-registry.ts";

const SESSION_BASELINE_FILENAME = "otherside-session-baseline";

// FETCH_HEAD older than this triggers a bounded background refresh of the
// default branch before basing a fresh worktree on it.
const FRESH_BASE_FETCH_STALENESS_MS = 86_400_000;
const FRESH_BASE_FETCH_TIMEOUT_MS = 5_000;

async function defaultBranchName(repoRoot: string): Promise<string | null> {
  const originHead = await git(repoRoot, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  if (originHead.ok) {
    const ref = originHead.stdout.trim();
    if (ref.startsWith("origin/") && ref !== "origin/HEAD") return ref.slice("origin/".length);
  }
  for (const candidate of ["main", "master"]) {
    if ((await revParse(repoRoot, `origin/${candidate}`)) !== null) return candidate;
  }
  return null;
}

async function fetchHeadAgeMs(repoRoot: string): Promise<number> {
  const gitDir = await git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!gitDir.ok) return Number.POSITIVE_INFINITY;
  try {
    const at = (await stat(join(gitDir.stdout.trim(), "FETCH_HEAD"))).mtimeMs;
    return Date.now() - at;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** PR-reference base: fetch `pull/<N>/head` from origin and pin FETCH_HEAD. */
export async function resolvePrBaseSha(repoRoot: string, prNumber: number): Promise<string> {
  const fetched = await git(repoRoot, ["fetch", "origin", `pull/${prNumber}/head`]);
  if (!fetched.ok) {
    throw new Error(
      `Failed to fetch PR #${prNumber}: PR may not exist or the repository may not have a remote named "origin"`,
    );
  }
  const sha = await revParse(repoRoot, "FETCH_HEAD");
  if (sha === null)
    throw new Error(`Failed to resolve base branch "FETCH_HEAD": git rev-parse failed`);
  return sha;
}

/**
 * Fresh mode bases the worktree on origin/<default>: an already-known remote
 * ref is used as-is (with a bounded refresh when FETCH_HEAD is stale), an
 * unknown one is fetched once, and HEAD is the fallback when the remote is
 * unreachable. Head mode resolves HEAD in the launch directory.
 */
export async function resolveFreshBaseSha(
  repoRoot: string,
  config: UserConfig,
  fromCwd: string,
): Promise<string> {
  const setting = config.worktree?.baseRef ?? "fresh";
  if (setting === "head") {
    const head = await revParse(fromCwd, "HEAD");
    if (head === null) throw new Error(`Could not resolve HEAD in ${fromCwd}`);
    return head;
  }
  const branch = await defaultBranchName(repoRoot);
  if (branch === null) {
    const head = await revParse(repoRoot, "HEAD");
    if (head === null) throw new Error("Could not resolve worktree base ref HEAD");
    return head;
  }
  const remoteRef = `origin/${branch}`;
  let sha = await revParse(repoRoot, remoteRef);
  if (sha !== null) {
    if ((await fetchHeadAgeMs(repoRoot)) > FRESH_BASE_FETCH_STALENESS_MS) {
      const fetched = await git(repoRoot, ["fetch", "origin", branch], {
        timeoutMs: FRESH_BASE_FETCH_TIMEOUT_MS,
      });
      if (fetched.ok) sha = (await revParse(repoRoot, remoteRef)) ?? sha;
    }
    return sha;
  }
  const fetched = await git(repoRoot, ["fetch", "origin", branch]);
  const ref = fetched.ok ? remoteRef : "HEAD";
  const resolved = await revParse(repoRoot, ref);
  if (resolved === null) throw new Error(`Could not resolve worktree base ref ${ref}`);
  return resolved;
}

/**
 * Reset a reused managed worktree to the current remote-default base when it
 * is safe: the tree is pristine, sits on its managed branch, and its HEAD is
 * either the recorded baseline or fully merged into the remote default.
 * Returns the new base sha, or null when any gate fails (resume as-is).
 */
export async function resetReusedWorktreeToFreshBase(
  repoRoot: string,
  worktreePath: string,
  expectedBranch: string,
  shas: { headSha: string | null; baselineSha: string | null },
): Promise<string | null> {
  const branch = await defaultBranchName(repoRoot);
  if (branch === null || branch.startsWith("-")) return null;
  const freshSha = await revParse(repoRoot, `origin/${branch}`);
  if (freshSha === null || freshSha === shas.headSha) return null;

  const current = await currentBranch(worktreePath);
  if (current !== expectedBranch) return null;

  const status = await git(worktreePath, ["--no-optional-locks", "status", "--porcelain"]);
  if (!status.ok || status.stdout.trim().length > 0) return null;

  const atBaseline = shas.baselineSha !== null && shas.headSha === shas.baselineSha;
  if (!atBaseline) {
    const remoteRef = await defaultRemoteRef(repoRoot);
    if (remoteRef === null || !(await allCommitsMergedInto(worktreePath, remoteRef))) return null;
  }

  try {
    const lockReason = await lockReasonFor(worktreePath, repoRoot);
    if (lockReason !== undefined && isLiveForeignSessionLock(lockReason)) return null;
  } catch {
    return null;
  }

  const reset = await git(worktreePath, ["reset", "--hard", freshSha]);
  if (!reset.ok) return null;
  await writeSessionBaseline(worktreePath, freshSha);
  return freshSha;
}

/** Short remote-default ref (`origin/<branch>`) resolved from origin/HEAD or common defaults. */
async function defaultRemoteRef(cwd: string): Promise<string | null> {
  const head = await git(cwd, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok && head.stdout.trim().length > 0) return head.stdout.trim();
  for (const candidate of ["origin/main", "origin/master"]) {
    if ((await revParse(cwd, candidate)) !== null) return candidate;
  }
  return null;
}

/**
 * True when the checked-out branch's upstream is gone and every HEAD commit
 * has an equivalent in `remoteRef` (cherry-pick equivalence, merges ignored).
 */
async function allCommitsMergedInto(worktreePath: string, remoteRef: string): Promise<boolean> {
  const headRef = await git(worktreePath, ["symbolic-ref", "-q", "HEAD"]);
  const fullRef = headRef.stdout.trim();
  if (!headRef.ok || fullRef.length === 0) return false;
  const track = await git(worktreePath, [
    "for-each-ref",
    "--format=%(upstream:track,nobracket)",
    fullRef,
  ]);
  if (!track.ok || track.stdout.trim() !== "gone") return false;
  const unmerged = await git(worktreePath, [
    "rev-list",
    "--cherry-pick",
    "--right-only",
    "--no-merges",
    "--max-count=1",
    `${remoteRef}...HEAD`,
  ]);
  return unmerged.ok && unmerged.stdout.trim().length === 0;
}

async function privateGitDir(path: string): Promise<string | null> {
  const result = await git(path, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const gitDir = result.stdout.trim();
  return result.ok && gitDir.length > 0 ? gitDir : null;
}

export async function writeSessionBaseline(path: string, sha: string): Promise<void> {
  const gitDir = await privateGitDir(path);
  if (gitDir === null) return;
  await writeFile(join(gitDir, SESSION_BASELINE_FILENAME), sha, "utf8").catch(() => {});
}

export async function readSessionBaseline(path: string): Promise<string | null> {
  const gitDir = await privateGitDir(path);
  if (gitDir === null) return null;
  try {
    const sha = (await readFile(join(gitDir, SESSION_BASELINE_FILENAME), "utf8")).trim();
    return /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}
