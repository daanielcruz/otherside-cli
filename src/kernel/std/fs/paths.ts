import { execFile, spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isWindows } from "../proc/platform.ts";

export function getDisplayPath(filePath: string): string {
  if (!isAbsolute(filePath)) return filePath;
  const rel = relative(process.cwd(), filePath);
  if (rel.length > 0 && !rel.startsWith("..")) return rel;
  const home = homedir();
  if (filePath.startsWith(home + sep)) return `~${filePath.slice(home.length)}`;
  return filePath;
}

export function configRoot(): string {
  if (process.env.OTHERSIDE_CONFIG_DIR) return process.env.OTHERSIDE_CONFIG_DIR;
  if (isWindows()) {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "Otherside");
  }
  return join(homedir(), ".otherside");
}

export function projectsRoot(): string {
  return join(configRoot(), "projects");
}

export const MAX_PERSISTED_TOOL_OUTPUT_BYTES = 64 * 1024 * 1024;

export function imageCacheRoot(): string {
  return join(configRoot(), "image-cache");
}

export function credentialsPath(): string {
  return join(configRoot(), "credentials.json");
}

export function shellSnapshotsDir(): string {
  return join(configRoot(), "shell-snapshots");
}

export function statsCachePath(): string {
  return join(configRoot(), "usage", "stats-cache.json");
}

export function sessionRegistryDir(): string {
  return join(configRoot(), "session-registry");
}

export function fileHistoryRoot(sessionId: string): string {
  return join(configRoot(), "file-history", sessionId);
}

const MAX_SLUG_LENGTH = 200;

export function projectSlug(cwd: string): string {
  const sanitized = cwd.replace(/[^A-Za-z0-9]/g, "-");
  if (sanitized.length <= MAX_SLUG_LENGTH) return sanitized;
  const hash =
    typeof Bun !== "undefined" ? Bun.hash(cwd).toString(36) : Math.abs(djb2(cwd)).toString(36);
  return `${sanitized.slice(0, MAX_SLUG_LENGTH)}-${hash}`;
}

function djb2(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) h = (h * 33) ^ str.charCodeAt(i);
  return h | 0;
}

export function projectPath(cwd: string): string {
  return join(projectsRoot(), projectSlug(cwd));
}

// Project-scoped storage that must NOT persist for transient cwds (fork-finalize,
// rewind temp dirs): ephemeral cwds route to a tmp tree (auto-reaped, never
// minting a real projects/<slug>/), everything else is the normal persistent
// projectPath. Non-ephemeral cwds get a byte-identical projectPath — no change.
export function ephemeralAwareProjectPath(cwd: string): string {
  return isEphemeralCwd(cwd)
    ? join(tmpdir(), "otherside-sessions", projectSlug(cwd))
    : projectPath(cwd);
}

export function startsWithDir(cwd: string, prefix: string): boolean {
  return cwd === prefix || cwd.startsWith(prefix + sep);
}

const EPHEMERAL_SEGMENT_PREFIXES = ["otherside-finalize-", "rev-um-"];

export function isEphemeralCwd(cwd: string): boolean {
  const posix = cwd.replaceAll("\\", "/");
  for (const segment of posix.split("/")) {
    if (EPHEMERAL_SEGMENT_PREFIXES.some((prefix) => segment.startsWith(prefix))) return true;
  }
  return false;
}

export function isEphemeralSlug(slug: string): boolean {
  if (slug.includes("-otherside-finalize-")) return true;
  if (slug.includes("-rev-um-")) return true;
  return false;
}

export function canonicalizeCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

/**
 * Nearest ancestor of `cwd` (inclusive) that carries a `.git` entry — a
 * directory for a main checkout, a file for a linked worktree. Pure fs walk:
 * the cheap "is this a git repo at all" gate that must run before any git
 * process is spawned (spawning `git` outside a repo is wasted work, and on
 * macOS without Command Line Tools every `git` invocation pops the CLT
 * installer dialog).
 */
export function gitAncestorRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      statSync(join(dir, ".git"));
      return dir;
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// One resume/list flow probes the same cwd several times (latest-session scan,
// resume-cwd assert); a short-lived memo collapses those into a single
// `git worktree list` spawn without letting long sessions read stale results.
const WORKTREE_LIST_MEMO_TTL_MS = 5_000;
const worktreeListMemo = new Map<string, { at: number; paths: string[] }>();

function memoizedWorktreePaths(cwd: string): string[] | null {
  const hit = worktreeListMemo.get(cwd);
  if (hit === undefined) return null;
  if (Date.now() - hit.at > WORKTREE_LIST_MEMO_TTL_MS) {
    worktreeListMemo.delete(cwd);
    return null;
  }
  return hit.paths;
}

function memoizeWorktreePaths(cwd: string, paths: string[]): string[] {
  worktreeListMemo.set(cwd, { at: Date.now(), paths });
  return paths;
}

// `git worktree list` with repo-local hook/fsmonitor execution disabled — the
// enumeration must never run configured hooks or spawn a filesystem monitor.
const WORKTREE_LIST_ARGS = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=",
  "worktree",
  "list",
  "--porcelain",
];

export function worktreePathsFor(cwd: string): string[] {
  const memo = memoizedWorktreePaths(cwd);
  if (memo !== null) return memo;
  if (gitAncestorRoot(cwd) === null) return memoizeWorktreePaths(cwd, []);
  const result = spawnSync("git", WORKTREE_LIST_ARGS, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1500,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return memoizeWorktreePaths(cwd, []);
  }
  return memoizeWorktreePaths(cwd, parseWorktreeList(result.stdout));
}

export function worktreePathsForAsync(cwd: string): Promise<string[]> {
  const memo = memoizedWorktreePaths(cwd);
  if (memo !== null) return Promise.resolve(memo);
  if (gitAncestorRoot(cwd) === null) return Promise.resolve(memoizeWorktreePaths(cwd, []));
  return new Promise((resolvePaths) => {
    execFile(
      "git",
      WORKTREE_LIST_ARGS,
      { cwd, encoding: "utf8", timeout: 1500 },
      (error, stdout) => {
        if (error || typeof stdout !== "string") {
          resolvePaths(memoizeWorktreePaths(cwd, []));
          return;
        }
        resolvePaths(memoizeWorktreePaths(cwd, parseWorktreeList(stdout)));
      },
    );
  });
}

function parseWorktreeList(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      const wt = line.slice("worktree ".length).trim();
      if (wt.length > 0) out.push(canonicalizeCwd(wt));
    }
  }
  return out;
}
