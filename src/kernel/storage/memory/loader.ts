import { dirname, resolve, sep } from "node:path";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { autoMemEntrypoint, trimEntrypointContent } from "@/kernel/storage/memory/entrypoint.ts";
import { expandImports } from "@/kernel/storage/memory/expand.ts";
import { isSessionMemoryEnabled } from "@/kernel/storage/memory/session-toggle.ts";
import type { MemoryFile } from "@/kernel/storage/memory/types.ts";
import {
  canonicalize,
  readFileSafe,
  readMemoryFile,
  walkAncestors,
} from "@/kernel/storage/memory/walker.ts";

const MEMORY_FILE_NAMES = ["OTHERSIDE.md", "CLAUDE.md"] as const;

function firstUserMemory(userRoot: string): { path: string; content: string } | null {
  for (const name of MEMORY_FILE_NAMES) {
    const path = resolve(userRoot, name);
    const content = readFileSafe(path);
    if (content !== null) return { path, content };
  }
  return null;
}

function firstProjectMemory(
  dir: string,
  dirRoot: string,
): { path: string; content: string } | null {
  for (const name of MEMORY_FILE_NAMES) {
    const path = resolve(dir, name);
    const content = readMemoryFile({ path, root: dirRoot });
    if (content !== null) return { path, content };
  }
  return null;
}

function autoMemFile(cwd: string, visited: Set<string>): MemoryFile | null {
  if (!isSessionMemoryEnabled()) return null;
  const entrypoint = autoMemEntrypoint(cwd);
  if (visited.has(entrypoint)) return null;
  const raw = readFileSafe(entrypoint);
  if (raw === null || raw.trim().length === 0) return null;
  visited.add(entrypoint);
  return { path: entrypoint, content: trimEntrypointContent(raw), scope: "automem" };
}

/**
 * Linked-worktree ancestry boundary: with cwd inside a linked worktree that
 * lives under its owner repository root, ancestor directories inside the
 * owner repo but outside the worktree belong to the MAIN checkout and are
 * skipped; ancestors above the owner repo still load.
 */
function worktreeAncestryExclusion(cwd: string): { ownerRoot: string; treeRoot: string } | null {
  const run = (args: string[]): string | null => {
    const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const value = result.stdout.toString().trim();
    return result.exitCode === 0 && value.length > 0 ? value : null;
  };
  const toplevel = run(["rev-parse", "--show-toplevel"]);
  const commonDir = run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (toplevel === null || commonDir === null) return null;
  const ownerRoot = canonicalize(dirname(commonDir));
  const treeRoot = canonicalize(toplevel);
  if (ownerRoot === treeRoot) return null;
  if (!`${treeRoot}${sep}`.startsWith(`${ownerRoot}${sep}`)) return null;
  return { ownerRoot, treeRoot };
}

function insideExclusionBand(
  dir: string,
  exclusion: { ownerRoot: string; treeRoot: string } | null,
): boolean {
  if (exclusion === null) return false;
  const canonical = canonicalize(dir);
  const inOwner =
    canonical === exclusion.ownerRoot ||
    `${canonical}${sep}`.startsWith(`${exclusion.ownerRoot}${sep}`);
  const inTree =
    canonical === exclusion.treeRoot ||
    `${canonical}${sep}`.startsWith(`${exclusion.treeRoot}${sep}`);
  return inOwner && !inTree;
}

export function collectMemoryFiles(cwd: string): MemoryFile[] {
  const out: MemoryFile[] = [];
  const visited = new Set<string>();

  const userRoot = canonicalize(configRoot());
  const user = firstUserMemory(userRoot);
  if (user !== null && !visited.has(user.path)) {
    visited.add(user.path);
    out.push({
      path: user.path,
      content: expandImports(user.content, {
        basePath: user.path,
        visited: new Set([user.path]),
        depth: 0,
        containmentRoot: userRoot,
      }).trim(),
      scope: "user",
    });
  }

  const exclusion = worktreeAncestryExclusion(cwd);
  for (const dir of walkAncestors(cwd)) {
    if (insideExclusionBand(dir, exclusion)) continue;
    const dirRoot = canonicalize(dir);
    const project = firstProjectMemory(dir, dirRoot);
    if (project === null) continue;
    if (visited.has(project.path)) continue;
    visited.add(project.path);
    out.push({
      path: project.path,
      content: expandImports(project.content, {
        basePath: project.path,
        visited: new Set([project.path]),
        depth: 0,
        containmentRoot: dirRoot,
      }).trim(),
      scope: "project",
    });
  }

  const auto = autoMemFile(cwd, visited);
  if (auto !== null) out.push(auto);

  return out;
}
