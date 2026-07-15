import { execFile, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
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

export function worktreePathsFor(cwd: string): string[] {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1500,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return [];
  return parseWorktreeList(result.stdout);
}

export function worktreePathsForAsync(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd, encoding: "utf8", timeout: 1500 },
      (error, stdout) => {
        if (error || typeof stdout !== "string") {
          resolve([]);
          return;
        }
        resolve(parseWorktreeList(stdout));
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
