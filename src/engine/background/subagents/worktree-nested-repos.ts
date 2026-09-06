import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { git } from "./worktree-git.ts";

interface LinkedNestedWorktree {
  readonly relativePath: string;
  readonly ownerRepo: string;
  readonly adminDir: string;
}

type NestedRepoAssessment =
  | { readonly kind: "blocked" }
  | { readonly kind: "clear"; readonly worktrees: readonly LinkedNestedWorktree[] };

let nestedRemovalHook: ((path: string) => void | Promise<void>) | null = null;

export function setNestedWorktreeRemovalHookForTests(
  hook: ((path: string) => void | Promise<void>) | null,
): void {
  nestedRemovalHook = hook;
}

export async function assessNestedRepos(area: string): Promise<NestedRepoAssessment> {
  const paths = await inspectNestedRepoPaths(area);
  if (paths === null) return { kind: "blocked" };
  const worktrees: LinkedNestedWorktree[] = [];
  for (const nestedPath of paths) {
    const link = await linkedWorktree(nestedPath);
    if (link === null || !(await isCleanWorktree(nestedPath))) return { kind: "blocked" };
    worktrees.push({ relativePath: relative(area, nestedPath), ...link });
  }
  worktrees.sort((a, b) => b.relativePath.split(sep).length - a.relativePath.split(sep).length);
  return { kind: "clear", worktrees };
}

export async function removeNestedWorktrees(
  area: string,
  worktrees: readonly LinkedNestedWorktree[],
): Promise<boolean> {
  for (const worktree of worktrees) {
    const path = join(area, worktree.relativePath);
    await nestedRemovalHook?.(path);
    const link = await linkedWorktree(path);
    if (
      link === null ||
      link.ownerRepo !== worktree.ownerRepo ||
      link.adminDir !== worktree.adminDir ||
      !(await isCleanWorktree(path)) ||
      !(await hasNoNestedRepos(path))
    ) {
      return false;
    }
    const removed = await git(worktree.ownerRepo, ["worktree", "remove", path]);
    if (!removed.ok) return false;
  }
  return true;
}

export async function hasNoNestedRepos(area: string): Promise<boolean> {
  const paths = await inspectNestedRepoPaths(area);
  return paths !== null && paths.length === 0;
}

async function isCleanWorktree(path: string): Promise<boolean> {
  const status = await git(path, ["status", "--porcelain", "--ignore-submodules=none"]);
  return status.ok && status.stdout.trim().length === 0;
}

async function linkedWorktree(
  nestedPath: string,
): Promise<{ ownerRepo: string; adminDir: string } | null> {
  const gitPath = join(nestedPath, ".git");
  try {
    if (!(await lstat(gitPath)).isFile()) return null;
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(gitPath, "utf-8"))?.[1];
    if (pointer === undefined) return null;
    const adminPath = resolve(nestedPath, pointer);
    const segments = adminPath.split(sep);
    if (segments.at(-2) !== "worktrees" || segments.at(-3) !== ".git") return null;
    const ownerPath = segments.slice(0, -3).join(sep) || sep;
    const adminDir = await realpath(adminPath);
    const ownerRepo = await realpath(ownerPath);
    const expectedCommon = await realpath(join(ownerRepo, ".git"));
    if (dirname(dirname(adminDir)) !== expectedCommon) return null;
    const commonPointer = (await readFile(join(adminDir, "commondir"), "utf-8")).trim();
    const backlink = (await readFile(join(adminDir, "gitdir"), "utf-8")).trim();
    if (commonPointer.length === 0 || backlink.length === 0) return null;
    if ((await realpath(resolve(adminDir, commonPointer))) !== expectedCommon) return null;
    if ((await realpath(resolve(adminDir, backlink))) !== (await realpath(gitPath))) return null;
    return { ownerRepo, adminDir };
  } catch {
    return null;
  }
}

// Unlike discovery for hints, a deletion gate scans every directory and rejects incomplete scans.
async function inspectNestedRepoPaths(area: string): Promise<string[] | null> {
  const pending = [area];
  const nested: string[] = [];
  try {
    while (pending.length > 0) {
      const path = pending.pop();
      if (path === undefined) break;
      if (!(await lstat(path)).isDirectory()) return null;
      const entries = await readdir(path, { withFileTypes: true });
      if (path !== area && (await hasGitEntry(path))) nested.push(path);
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== ".git") {
          pending.push(join(path, entry.name));
        }
      }
    }
    return nested;
  } catch {
    return null;
  }
}

async function hasGitEntry(path: string): Promise<boolean> {
  try {
    await lstat(join(path, ".git"));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
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
