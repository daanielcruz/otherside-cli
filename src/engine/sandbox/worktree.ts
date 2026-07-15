import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

let cachedWorktreeMainRepo: string | null | undefined;

export function resetWorktreeCacheForTests(): void {
  cachedWorktreeMainRepo = undefined;
}

function readGitFile(gitPath: string): string | null {
  try {
    const info = statSync(gitPath);
    if (!info.isFile()) return null;
    return readFileSync(gitPath, "utf8");
  } catch {
    return null;
  }
}

function extractGitDirRef(content: string): string | null {
  const line = content.split("\n").find((l) => l.startsWith("gitdir:"));
  if (!line) return null;
  return line.slice("gitdir:".length).trim();
}

function resolveMainRepoFromGitDir(gitdirRef: string, cwd: string): string | null {
  const absoluteGitDir = isAbsolute(gitdirRef) ? gitdirRef : resolve(cwd, gitdirRef);
  const segments = absoluteGitDir.split("/");
  const worktreesIdx = segments.lastIndexOf("worktrees");
  if (worktreesIdx <= 0) return null;
  const gitDirIdx = worktreesIdx - 1;
  if (segments[gitDirIdx] !== ".git") return null;
  return segments.slice(0, gitDirIdx).join("/");
}

export function detectWorktreeMainRepoPath(cwd: string = process.cwd()): string | null {
  if (cachedWorktreeMainRepo !== undefined) return cachedWorktreeMainRepo;
  const gitPath = join(cwd, ".git");
  const content = readGitFile(gitPath);
  if (!content) {
    cachedWorktreeMainRepo = null;
    return null;
  }
  const gitdirRef = extractGitDirRef(content);
  if (!gitdirRef) {
    cachedWorktreeMainRepo = null;
    return null;
  }
  const mainRepo = resolveMainRepoFromGitDir(gitdirRef, dirname(gitPath));
  cachedWorktreeMainRepo = mainRepo;
  return mainRepo;
}
