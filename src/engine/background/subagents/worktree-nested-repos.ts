import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { git } from "./worktree-git.ts";

interface NestedRepoAssessment {
  readonly kind: "clear" | "blocked";
  /** Owner repos of linked nested worktrees, deduplicated. */
  readonly ownerRepos: readonly string[];
}

// A nested repo inside the area holds work the surrounding repo cannot see or
// restore. A clean LINKED worktree is the only disposable shape: its commits
// live in the owner repo and only the checkout dies with the area. A full repo
// carries its sole object database, and a dirty or unreadable one carries
// uncommitted work — all of those block removal.
export async function assessNestedRepos(area: string): Promise<NestedRepoAssessment> {
  const owners = new Set<string>();
  for (const nestedPath of await findNestedRepos(area)) {
    const owner = await linkedWorktreeOwner(nestedPath);
    if (owner === null) return { kind: "blocked", ownerRepos: [] };
    const status = await git(nestedPath, ["status", "--porcelain"]);
    if (!status.ok || status.stdout.trim().length > 0) return { kind: "blocked", ownerRepos: [] };
    owners.add(owner);
  }
  return { kind: "clear", ownerRepos: [...owners] };
}

// A linked worktree keeps a `.git` FILE pointing at the owner's admin dir
// (`<owner>/.git/worktrees/<name>`); a full repo keeps a `.git` directory.
// Returns the owner repo root, or null when the shape is not a linked worktree.
async function linkedWorktreeOwner(nestedPath: string): Promise<string | null> {
  const gitPath = join(nestedPath, ".git");
  try {
    if (!(await lstat(gitPath)).isFile()) return null;
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(gitPath, "utf-8"))?.[1];
    if (pointer === undefined) return null;
    const adminDir = isAbsolute(pointer) ? pointer : resolve(nestedPath, pointer);
    const segments = adminDir.split(sep);
    if (segments.at(-2) !== "worktrees" || segments.at(-3) !== ".git") return null;
    return segments.slice(0, -3).join(sep) || sep;
  } catch {
    return null;
  }
}

const NESTED_SCAN_SKIP = new Set([".git", "node_modules", ".otherside", ".githooks"]);
const NESTED_SCAN_MAX_DEPTH = 2;

export async function findNestedRepos(
  toplevel: string,
  depth = NESTED_SCAN_MAX_DEPTH,
): Promise<string[]> {
  if (depth <= 0) return [];
  const nested: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(toplevel, { withFileTypes: true });
  } catch {
    return nested;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || NESTED_SCAN_SKIP.has(entry.name)) continue;
    const subPath = join(toplevel, entry.name);
    if (await isGitRepo(subPath)) {
      nested.push(subPath);
      continue;
    }
    nested.push(...(await findNestedRepos(subPath, depth - 1)));
  }
  return nested;
}

async function isGitRepo(path: string): Promise<boolean> {
  try {
    await stat(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
}
