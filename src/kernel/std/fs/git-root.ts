import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// Walks toward the filesystem root so subdirectories of a repository still
// resolve it. The `.git` entry is a directory for a normal repo root and a
// file for a linked worktree; existence covers both.
export function findGitRoot(start: string): string | null {
  let current = start;
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}
