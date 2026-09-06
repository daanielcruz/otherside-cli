import { cp, lstat, mkdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  cleanupPartialOverlayDest,
  exceedsWindowsPathLimit,
  isUnmaterializablePathError,
} from "./worktree-filesystem.ts";
import { git, gitApply, gitBytes, UNTRACKED_FILES_ARGS } from "./worktree-git.ts";
import { errnoCode } from "./worktree-lock.ts";

let overlayCopyHook: ((from: string, to: string) => void | Promise<void>) | null = null;

export function setWorktreeOverlayCopyHookForTests(
  hook: ((from: string, to: string) => void | Promise<void>) | null,
): void {
  overlayCopyHook = hook;
}

export async function replicateDirtyChanges(
  repoRoot: string,
  worktreePath: string,
  omittedRoots: readonly string[],
): Promise<void> {
  const diff = await gitBytes(repoRoot, ["-c", "core.autocrlf=false", "diff", "HEAD", "--binary"]);
  if (!diff.ok) throw new Error("worktree isolation: failed to snapshot tracked changes");
  if (diff.stdout.byteLength > 0 && !(await gitApply(worktreePath, diff.stdout))) {
    throw new Error("worktree isolation: failed to apply tracked changes");
  }

  const untracked = await git(repoRoot, UNTRACKED_FILES_ARGS);
  if (!untracked.ok) throw new Error("worktree isolation: failed to list untracked files");
  const omittedRelPaths = omittedRoots.map((path) => relative(repoRoot, path).split(sep).join("/"));
  const relPaths = untracked.stdout
    .split("\0")
    .filter((path) => path.length > 0)
    .filter((path) => {
      const normalized = path.replace(/\/+$/, "");
      return !omittedRelPaths.some(
        (omitted) => normalized === omitted || normalized.startsWith(`${omitted}/`),
      );
    });
  // Settle every copy before surfacing a failure so no cp is still writing into
  // the worktree while the caller rolls the torn creation back.
  const copies = await Promise.allSettled(
    relPaths.map(async (rel) => {
      const from = join(repoRoot, rel);
      const to = join(worktreePath, rel);
      // Avoid mkdir of paths Windows/Git cannot later delete (long-path trees
      // poison `git worktree remove` even when the file copy itself is skipped).
      if (exceedsWindowsPathLimit(to)) return;
      try {
        await mkdir(dirname(to), { recursive: true });
        await overlayCopyHook?.(from, to);
        await cp(from, to);
      } catch (error) {
        // Drop any partial dest (empty long-path dirs) before deciding fate —
        // those trees poison later `git worktree remove` on Windows.
        await cleanupPartialOverlayDest(worktreePath, to);
        // Untracked files are a point-in-time snapshot. A file that vanished
        // after `ls-files` is no longer part of the source overlay — only skip
        // when the source is actually gone (do not trust error.path alone:
        // Windows long-path dest failures often report the source path).
        // Use lstat so a broken symlink still counts as present (stat would
        // ENOENT-follow and misclassify it as vanished).
        try {
          await lstat(from);
        } catch (statErr) {
          if (errnoCode(statErr) === "ENOENT") return;
          // Unexpected probe failure — surface the original copy error rather
          // than masking a real overlay failure behind the probe.
          throw error;
        }
        // Source still exists but this platform cannot materialize `to` (classic
        // Windows MAX_PATH / Git "Filename too long"). Skip rather than fail the
        // whole worktree — the path is unusable as an overlay target here.
        if (isUnmaterializablePathError(error)) return;
        throw error;
      }
    }),
  );
  const failed = copies.find((result) => result.status === "rejected");
  if (failed !== undefined && failed.status === "rejected") {
    throw new Error(`worktree isolation: failed to copy untracked file: ${String(failed.reason)}`);
  }
}
