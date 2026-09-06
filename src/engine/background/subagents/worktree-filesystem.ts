import { lstat, readdir, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

// Windows rejects paths beyond MAX_PATH (~260) unless long-path APIs are used.
// Git for Windows also fails ("Filename too long") on deep trees without
// core.longpaths. Keep a safety margin under the classic limit.
const WINDOWS_MAX_PATH = 260;
const WINDOWS_PATH_SAFETY_MARGIN = 12;

export function isWindowsPlatform(): boolean {
  return process.platform === "win32";
}

export function win32LongPath(path: string): string {
  if (!isWindowsPlatform()) return path;
  if (path.startsWith("\\\\?\\")) return path;
  const normalized = resolve(path);
  if (normalized.startsWith("\\\\")) {
    return `\\\\?\\UNC\\${normalized.slice(2)}`;
  }
  return `\\\\?\\${normalized}`;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

// Best-effort recursive delete. Windows commonly returns EBUSY/EPERM while a
// handle is closing, and Git may leave long-path trees that `git worktree remove`
// cannot delete — retry and use the \\?\ long-path form on win32.
export async function removeDirRobust(path: string, attempts = 6): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (!(await pathExists(path))) return true;
    try {
      await rm(path, { recursive: true, force: true });
    } catch {
      if (isWindowsPlatform()) {
        try {
          await rm(win32LongPath(path), { recursive: true, force: true });
        } catch {}
      }
    }
    if (!(await pathExists(path))) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 20 * (i + 1)));
  }
  return !(await pathExists(path));
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

export function isUnmaterializablePathError(error: unknown): boolean {
  if (!isErrnoException(error)) return false;
  if (error.code === "ENAMETOOLONG") return true;
  // On Windows, copyfile/mkdir often surfaces dest-too-long as ENOENT while
  // still reporting the source path — treat that as unmaterializable only when
  // the source is still present (checked by the caller).
  return isWindowsPlatform() && error.code === "ENOENT";
}

export function exceedsWindowsPathLimit(path: string): boolean {
  return isWindowsPlatform() && path.length >= WINDOWS_MAX_PATH - WINDOWS_PATH_SAFETY_MARGIN;
}

// Remove a failed overlay dest and any empty parents created under the worktree
// for it. Leaves non-empty siblings alone.
export async function cleanupPartialOverlayDest(worktreePath: string, to: string): Promise<void> {
  await rm(to, { recursive: true, force: true }).catch(() => {});
  const root = resolve(worktreePath);
  let current = dirname(to);
  while (true) {
    const resolved = resolve(current);
    if (resolved === root || !resolved.startsWith(root + sep)) break;
    try {
      const entries = await readdir(resolved);
      if (entries.length > 0) break;
      await rm(resolved, { recursive: true, force: true });
    } catch {
      break;
    }
    current = dirname(resolved);
  }
}
