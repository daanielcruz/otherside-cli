import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { UserConfig } from "@/kernel/config/config.ts";
import { git } from "./worktree-git.ts";
import { pathInside, samePath } from "./worktree-path.ts";

export async function configureSparseCheckout(
  repoRoot: string,
  worktreePath: string,
  sparsePaths: string[],
): Promise<void> {
  const fail = async (message: string): Promise<never> => {
    await git(repoRoot, ["worktree", "remove", "--force", worktreePath]);
    await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    throw new Error(message);
  };
  const existing = await git(repoRoot, ["config", "--local", "--get", "extensions.worktreeConfig"]);
  if (!existing.ok) {
    const set = await git(repoRoot, ["config", "--local", "extensions.worktreeConfig", "true"]);
    if (!set.ok) await fail("Failed to enable the worktree config extension for sparse checkout");
  }
  const sparse = await git(worktreePath, [
    "sparse-checkout",
    "set",
    "--cone",
    "--",
    ...sparsePaths,
  ]);
  if (!sparse.ok) await fail("Failed to configure sparse-checkout");
  const checkout = await git(worktreePath, ["checkout", "HEAD"]);
  if (!checkout.ok) await fail("Failed to checkout sparse worktree");
}

/**
 * One-time setup for a freshly created worktree: project-local settings copy,
 * hooks-path forwarding to the main checkout, and configured directory
 * symlinks. Every step is best-effort and guarded against destinations that
 * escape the worktree through committed symlinks.
 */
export async function prepareCreatedWorktree(
  repoRoot: string,
  worktreePath: string,
  config: UserConfig,
): Promise<void> {
  const worktreeReal = await realpath(worktreePath).catch(() => null);
  if (worktreeReal === null) return;
  await copyLocalSettingsIntoWorktree(repoRoot, worktreePath, worktreeReal);
  await forwardHooksPath(repoRoot, worktreePath);
  const symlinkDirs = config.worktree?.symlinkDirectories ?? [];
  if (symlinkDirs.length > 0) {
    await symlinkWorktreeDirectories(repoRoot, worktreePath, worktreeReal, symlinkDirs);
  }
  await copyWorktreeSeedFiles(repoRoot, worktreePath, worktreeReal);
}

/**
 * Copy git-ignored files matching the repo's `.worktreeinclude` patterns
 * (gitignore syntax) into a fresh worktree — ignored files never arrive via
 * checkout, so env-style local files are propagated here. Ignored directories
 * are only expanded when a pattern plausibly targets them. Symlink sources and
 * destinations that escape the worktree are skipped. Best-effort throughout.
 */
async function copyWorktreeSeedFiles(
  repoRoot: string,
  worktreePath: string,
  worktreeReal: string,
): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(join(repoRoot, ".worktreeinclude"), "utf8");
  } catch {
    return [];
  }
  const patterns = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (patterns.length === 0) return [];

  const listed = await git(repoRoot, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  if (!listed.ok || listed.stdout.trim().length === 0) return [];
  const entries = listed.stdout.split("\n").filter((line) => line.length > 0);
  const files = entries.filter((entry) => !entry.endsWith("/"));
  const dirs = entries.filter((entry) => entry.endsWith("/"));

  const matcher = await gitignoreMatcher(patterns, [
    ...files,
    ...dirs.map((dir) => dir.slice(0, -1)),
  ]);
  const selected = files.filter((file) => matcher.has(file));

  const expandDirs = dirs.filter((dir) => {
    if (
      patterns.some((pattern) => {
        const cleaned = pattern.startsWith("/") ? pattern.slice(1) : pattern;
        if (cleaned.startsWith(dir)) return true;
        const wildcardAt = cleaned.search(/[*?[]/);
        return wildcardAt > 0 && dir.startsWith(cleaned.slice(0, wildcardAt));
      })
    ) {
      return true;
    }
    return matcher.has(dir.slice(0, -1));
  });
  if (expandDirs.length > 0) {
    const expanded = await git(repoRoot, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--",
      ...expandDirs,
    ]);
    if (expanded.ok && expanded.stdout.trim().length > 0) {
      const expandedFiles = expanded.stdout.split("\n").filter((line) => line.length > 0);
      const expandedMatch = await gitignoreMatcher(patterns, expandedFiles);
      for (const file of expandedFiles) {
        if (expandedMatch.has(file)) selected.push(file);
      }
    }
  }

  const copied: string[] = [];
  for (const relative of selected) {
    const source = join(repoRoot, relative);
    const destination = join(worktreePath, relative);
    try {
      if ((await lstat(source)).isSymbolicLink()) continue;
      if (await writeDestEscapesWorktree(destination, worktreeReal)) continue;
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      copied.push(relative);
    } catch {
      // best-effort propagation; the worktree still works without the file
    }
  }
  return copied;
}

/**
 * Match relative paths against gitignore-syntax patterns with git's own
 * matcher: a throwaway repo carries the patterns as its exclude file and
 * `check-ignore` reports which candidates match.
 */
async function gitignoreMatcher(patterns: string[], candidates: string[]): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  let scratch: string | null = null;
  try {
    scratch = await mkdtemp(join(tmpdir(), "otherside-wt-include-"));
    const init = await git(scratch, ["init", "-q"]);
    if (!init.ok) return new Set();
    await mkdir(join(scratch, ".git", "info"), { recursive: true });
    await writeFile(join(scratch, ".git", "info", "exclude"), `${patterns.join("\n")}\n`, "utf8");
    const proc = Bun.spawn(["git", "-C", scratch, "check-ignore", "--stdin"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    proc.stdin.write(`${candidates.join("\n")}\n`);
    await proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return new Set(stdout.split("\n").filter((line) => line.length > 0));
  } catch {
    return new Set();
  } finally {
    if (scratch !== null) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

async function copyLocalSettingsIntoWorktree(
  repoRoot: string,
  worktreePath: string,
  worktreeReal: string,
): Promise<void> {
  const relative = join(".otherside", "settings.local.json");
  const source = join(repoRoot, relative);
  try {
    if ((await lstat(source)).isSymbolicLink()) return;
  } catch {
    return;
  }
  const destination = join(worktreePath, relative);
  if (await writeDestEscapesWorktree(destination, worktreeReal)) return;
  try {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  } catch {
    // best-effort propagation; the worktree still works without local settings
  }
}

async function forwardHooksPath(repoRoot: string, worktreePath: string): Promise<void> {
  const configured = await git(repoRoot, ["config", "--get", "core.hooksPath"]);
  if (!configured.ok) return;
  const raw = configured.stdout.trim();
  if (raw.length === 0 || isAbsolute(raw)) return;
  // A relative hooks path resolves against each checkout; forwarding the
  // absolute main-checkout location keeps the same hooks running in the
  // worktree.
  const absolute = resolve(repoRoot, raw);
  await git(worktreePath, ["config", "core.hooksPath", absolute]);
}

async function symlinkWorktreeDirectories(
  repoRoot: string,
  worktreePath: string,
  worktreeReal: string,
  entries: string[],
): Promise<void> {
  for (const entry of entries) {
    if (isAbsolute(entry) || entry.split(/[/\\]/).some((segment) => /^\.\.[ .]*$/.test(segment))) {
      continue;
    }
    const source = join(repoRoot, entry);
    const destination = join(worktreePath, entry);
    try {
      await lstat(source);
    } catch {
      continue;
    }
    if (await writeDestEscapesWorktree(destination, worktreeReal)) continue;
    try {
      await symlink(source, destination, "dir");
    } catch {
      // ENOENT/EEXIST are expected when the tree already carries the entry
    }
  }
}

/**
 * True when writing at `destination` would land outside the worktree — the
 * nearest existing ancestor must realpath-resolve inside it and the
 * destination itself must not be a symlink.
 */
async function writeDestEscapesWorktree(
  destination: string,
  worktreeReal: string,
): Promise<boolean> {
  let dir = dirname(destination);
  for (;;) {
    try {
      const real = await realpath(dir);
      if (!samePath(real, worktreeReal) && !pathInside(real, worktreeReal)) return true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
      const exists = await lstat(dir).then(
        () => true,
        (e) => (e as NodeJS.ErrnoException).code !== "ENOENT",
      );
      if (exists) return true;
      const parent = dirname(dir);
      if (parent === dir) return true;
      dir = parent;
    }
  }
  try {
    if ((await lstat(destination)).isSymbolicLink()) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
  }
  return false;
}
