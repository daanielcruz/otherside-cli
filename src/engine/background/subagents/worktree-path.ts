import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { startsWithDir } from "@/kernel/std/fs/paths.ts";

export interface PathPlatform {
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  sep: string;
}

const nativePath: PathPlatform = { relative, isAbsolute, sep };

export function isPathWithinRoot(
  root: string,
  path: string,
  pathPlatform: PathPlatform = nativePath,
): boolean {
  const relativePath = pathPlatform.relative(root, path);
  return (
    relativePath === "" ||
    (!pathPlatform.isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${pathPlatform.sep}`))
  );
}

export async function isWriteEscapingWorktree(dest: string, root: string): Promise<boolean> {
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(root);
  } catch {
    resolvedRoot = root;
  }

  try {
    const stats = await lstat(dest);
    if (stats.isSymbolicLink()) {
      return true;
    }
  } catch {
    // Dest does not exist or cannot be lstated
  }

  let current = dest;
  while (true) {
    try {
      await lstat(current);
      const resolvedCurrent = await realpath(current);
      return !startsWithDir(resolvedCurrent, resolvedRoot);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  return true;
}
