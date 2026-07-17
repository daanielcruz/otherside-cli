import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { startsWithDir } from "@/kernel/std/fs/paths.ts";

// Windows rejects paths beyond MAX_PATH (~260) unless long-path APIs are used.
// Git for Windows also fails ("Filename too long") on deep trees without
// core.longpaths. Keep a safety margin under the classic limit.
const WINDOWS_MAX_PATH = 260;
const WINDOWS_PATH_SAFETY_MARGIN = 12;

function isWindowsPlatform(): boolean {
  return process.platform === "win32";
}

function win32LongPath(path: string): string {
  if (!isWindowsPlatform()) return path;
  if (path.startsWith("\\\\?\\")) return path;
  const normalized = resolve(path);
  if (normalized.startsWith("\\\\")) {
    return `\\\\?\\UNC\\${normalized.slice(2)}`;
  }
  return `\\\\?\\${normalized}`;
}

async function pathExists(path: string): Promise<boolean> {
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
async function removeDirRobust(path: string, attempts = 6): Promise<boolean> {
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

function isUnmaterializablePathError(error: unknown): boolean {
  if (!isErrnoException(error)) return false;
  if (error.code === "ENAMETOOLONG") return true;
  // On Windows, copyfile/mkdir often surfaces dest-too-long as ENOENT while
  // still reporting the source path — treat that as unmaterializable only when
  // the source is still present (checked by the caller).
  return isWindowsPlatform() && error.code === "ENOENT";
}

function exceedsWindowsPathLimit(path: string): boolean {
  return isWindowsPlatform() && path.length >= WINDOWS_MAX_PATH - WINDOWS_PATH_SAFETY_MARGIN;
}

// Remove a failed overlay dest and any empty parents created under the worktree
// for it. Leaves non-empty siblings alone.
async function cleanupPartialOverlayDest(worktreePath: string, to: string): Promise<void> {
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

export interface Worktree {
  path: string;
  branch: string;
  warning?: string;
  cleanup: () => Promise<{ deleted: boolean }>;
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return { ok: code === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

async function gitBytes(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: Uint8Array }> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    const code = await proc.exited;
    return { ok: code === 0, stdout };
  } catch {
    return { ok: false, stdout: new Uint8Array() };
  }
}

async function gitApply(cwd: string, patch: Uint8Array): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      ["git", "-C", cwd, "-c", "core.autocrlf=false", "apply", "--whitespace=nowarn"],
      {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    proc.stdin.write(patch);
    await proc.stdin.end();
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

const UNTRACKED_FILES_ARGS = [
  "ls-files",
  "--others",
  "--exclude-standard",
  "-z",
  "--",
  ".",
  ":(exclude).otherside/worktrees",
  ":(exclude).otherside/worktrees/**",
];

let overlayCopyHook: ((from: string, to: string) => void | Promise<void>) | null = null;

export function setWorktreeOverlayCopyHookForTests(
  hook: ((from: string, to: string) => void | Promise<void>) | null,
): void {
  overlayCopyHook = hook;
}

async function replicateDirtyChanges(
  repoRoot: string,
  worktreePath: string,
  omittedRoots: readonly string[],
): Promise<void> {
  const diff = await gitBytes(repoRoot, ["-c", "core.autocrlf=false", "diff", "HEAD", "--binary"]);
  if (!diff.ok) throw new Error("worktree isolation: failed to snapshot tracked changes");
  if (diff.stdout.byteLength > 0 && !(await gitApply(worktreePath, diff.stdout))) {
    throw new Error("worktree isolation: failed to apply tracked changes");
  }

  const untracked = await git(repoRoot, UNTRACKED_FILES_ARGS);
  if (!untracked.ok) throw new Error("worktree isolation: failed to list untracked files");
  const omittedRelPaths = omittedRoots.map((path) => relative(repoRoot, path).split(sep).join("/"));
  const relPaths = untracked.stdout
    .split("\0")
    .filter((path) => path.length > 0)
    .filter((path) => {
      const normalized = path.replace(/\/+$/, "");
      return !omittedRelPaths.some(
        (omitted) => normalized === omitted || normalized.startsWith(`${omitted}/`),
      );
    });
  // Settle every copy before surfacing a failure so no cp is still writing into
  // the worktree while the caller rolls the torn creation back.
  const copies = await Promise.allSettled(
    relPaths.map(async (rel) => {
      const from = join(repoRoot, rel);
      const to = join(worktreePath, rel);
      // Avoid mkdir of paths Windows/Git cannot later delete (long-path trees
      // poison `git worktree remove` even when the file copy itself is skipped).
      if (exceedsWindowsPathLimit(to)) return;
      try {
        await mkdir(dirname(to), { recursive: true });
        await overlayCopyHook?.(from, to);
        await cp(from, to);
      } catch (error) {
        // Drop any partial dest (empty long-path dirs) before deciding fate —
        // those trees poison later `git worktree remove` on Windows.
        await cleanupPartialOverlayDest(worktreePath, to);
        // Untracked files are a point-in-time snapshot. A file that vanished
        // after `ls-files` is no longer part of the source overlay — only skip
        // when the source is actually gone (do not trust error.path alone:
        // Windows long-path dest failures often report the source path).
        // Use lstat so a broken symlink still counts as present (stat would
        // ENOENT-follow and misclassify it as vanished).
        try {
          await lstat(from);
        } catch (statErr) {
          if (errnoCode(statErr) === "ENOENT") return;
          // Unexpected probe failure — surface the original copy error rather
          // than masking a real overlay failure behind the probe.
          throw error;
        }
        // Source still exists but this platform cannot materialize `to` (classic
        // Windows MAX_PATH / Git "Filename too long"). Skip rather than fail the
        // whole worktree — the path is unusable as an overlay target here.
        if (isUnmaterializablePathError(error)) return;
        throw error;
      }
    }),
  );
  const failed = copies.find((result) => result.status === "rejected");
  if (failed !== undefined && failed.status === "rejected") {
    throw new Error(`worktree isolation: failed to copy untracked file: ${String(failed.reason)}`);
  }
}

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

function worktreeSlug(agentId: string): string {
  return agentId.replace(/[^a-zA-Z0-9_-]/g, "-");
}

const ORPHAN_SLUG_PATTERN = /^(fork_[0-9a-z]+_[0-9a-z]+|workflow-[a-zA-Z0-9_-]+)$/;

async function canonicalGitRoot(cwd: string): Promise<string | null> {
  const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) return null;
  const dir = common.stdout.trim();
  return dir.length > 0 ? dirname(dir) : null;
}

async function activeWorktreeRoot(cwd: string): Promise<string | null> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return null;
  const root = top.stdout.trim();
  return root.length > 0 ? resolve(root) : null;
}

const BASELINE_FILENAME = "otherside-base.json";
const BASELINE_VERSION = 2;

interface WorktreeBaseline {
  version: typeof BASELINE_VERSION;
  head: string;
  fingerprint: string;
  tree: string;
}

function hashFrame(
  hash: ReturnType<typeof createHash>,
  label: string,
  value: string | Uint8Array,
): void {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  hash.update(`${label.length}:${label}:${bytes.byteLength}:`);
  hash.update(bytes);
}

async function calculateFingerprint(cwd: string): Promise<string | null> {
  try {
    const diff = await gitBytes(cwd, ["diff", "HEAD", "--binary", "--no-ext-diff"]);
    if (!diff.ok) return null;
    const untracked = await git(cwd, UNTRACKED_FILES_ARGS);
    if (!untracked.ok) return null;

    const hash = createHash("sha256");
    hashFrame(hash, "tracked-diff", diff.stdout);
    const relPaths = untracked.stdout
      .split("\0")
      .filter((path) => path.length > 0)
      .sort();
    for (const rel of relPaths) {
      const info = await lstat(join(cwd, rel));
      hashFrame(hash, "path", rel);
      hashFrame(hash, "mode", String(info.mode));
      if (info.isSymbolicLink()) {
        hashFrame(hash, "symlink", await readlink(join(cwd, rel)));
      } else if (info.isFile()) {
        hashFrame(hash, "file", await readFile(join(cwd, rel)));
      } else {
        hashFrame(hash, "other", "");
      }
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

function parseBaseline(raw: string): WorktreeBaseline | null {
  try {
    const value = JSON.parse(raw) as Partial<WorktreeBaseline>;
    if (value.version !== BASELINE_VERSION) return null;
    if (typeof value.head !== "string" || !/^[0-9a-f]{40,64}$/i.test(value.head)) return null;
    if (typeof value.fingerprint !== "string" || !/^[0-9a-f]{64}$/i.test(value.fingerprint)) {
      return null;
    }
    if (typeof value.tree !== "string" || !/^[0-9a-f]{40,64}$/i.test(value.tree)) return null;
    return value as WorktreeBaseline;
  } catch {
    return null;
  }
}

async function privateGitDir(path: string): Promise<string | null> {
  const result = await git(path, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const dir = result.stdout.trim();
  return result.ok && dir.length > 0 ? dir : null;
}

async function readBaseline(path: string): Promise<WorktreeBaseline | null> {
  const gitDir = await privateGitDir(path);
  if (gitDir === null) return null;
  try {
    return parseBaseline(await readFile(join(gitDir, BASELINE_FILENAME), "utf-8"));
  } catch {
    return null;
  }
}

async function writeBaseline(path: string, baseline: WorktreeBaseline): Promise<boolean> {
  const gitDir = await privateGitDir(path);
  if (gitDir === null) return false;
  try {
    await writeFile(join(gitDir, BASELINE_FILENAME), JSON.stringify(baseline), "utf-8");
    return true;
  } catch {
    return false;
  }
}

const LEASE_FILENAME = "otherside-lease.json";
const LEASE_VERSION = 1;
// A lease from another host cannot be probed by pid; trust it only while fresh.
const LEASE_CROSS_HOST_TTL_MS = 6 * 60 * 60 * 1000;

interface WorktreeLeaseRecord {
  version: typeof LEASE_VERSION;
  pid: number;
  host: string;
  updatedAt: number;
}

// A run-lifetime claim on a worktree. It is NOT taken at creation — the run
// layer (fork loop / workflow bridge) acquires it once it starts driving the
// worktree and releases it before cleanup, so orphan pruning can tell a live
// agent's worktree from a truly abandoned one regardless of its age.
export interface WorktreeLease {
  release: () => Promise<void>;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH → gone; EPERM → exists but owned by another user.
    return errnoCode(error) === "EPERM";
  }
}

function parseLease(raw: string): WorktreeLeaseRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<WorktreeLeaseRecord>;
    if (value.version !== LEASE_VERSION) return null;
    if (typeof value.pid !== "number" || !Number.isInteger(value.pid)) return null;
    if (typeof value.host !== "string" || value.host.length === 0) return null;
    if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return null;
    return value as WorktreeLeaseRecord;
  } catch {
    return null;
  }
}

async function leaseFilePath(path: string): Promise<string | null> {
  const gitDir = await privateGitDir(path);
  return gitDir === null ? null : join(gitDir, LEASE_FILENAME);
}

export async function acquireWorktreeLease(path: string): Promise<WorktreeLease> {
  const file = await leaseFilePath(path);
  const record: WorktreeLeaseRecord = {
    version: LEASE_VERSION,
    pid: process.pid,
    host: hostname(),
    updatedAt: Date.now(),
  };
  if (file !== null) {
    try {
      await writeFile(file, JSON.stringify(record), "utf-8");
    } catch {}
  }
  let released = false;
  return {
    async release() {
      if (released || file === null) return;
      released = true;
      try {
        // Drop the marker only if it is still ours — a crash-stealer that rewrote
        // the lease for the same path must keep its own claim.
        const current = parseLease(await readFile(file, "utf-8"));
        if (current !== null && current.pid === process.pid && current.host === record.host) {
          await rm(file, { force: true });
        }
      } catch {}
    },
  };
}

// A resumed fork reuses the isolation worktree its original run created instead
// of going through createWorktree (which would re-run the git setup). Refresh
// the directory mtime so the orphan prune's age check treats it as active, then
// take the same run-lifetime lease the fork loop holds so the prune's
// fail-closed guard cannot reclaim the worktree under the live resumed agent.
// The caller releases the returned lease when the resumed run settles.
export async function acquireResumedWorktreeLease(path: string): Promise<WorktreeLease> {
  try {
    const now = new Date();
    await utimes(path, now, now);
  } catch {}
  return acquireWorktreeLease(path);
}

async function isWorktreeLeaseLive(path: string): Promise<boolean> {
  const file = await leaseFilePath(path);
  if (file === null) return false;
  let record: WorktreeLeaseRecord | null;
  try {
    record = parseLease(await readFile(file, "utf-8"));
  } catch {
    // No marker → not live (released cleanly, or was never leased).
    return false;
  }
  if (record === null) return false;
  if (record.host === hostname()) return pidAlive(record.pid);
  return Date.now() - record.updatedAt < LEASE_CROSS_HOST_TTL_MS;
}

async function matchesBaseline(path: string, baseline: WorktreeBaseline): Promise<boolean> {
  const head = await git(path, ["rev-parse", "HEAD"]);
  if (!head.ok || head.stdout.trim() !== baseline.head) return false;
  const fingerprint = await calculateFingerprint(path);
  return fingerprint !== null && fingerprint === baseline.fingerprint;
}

async function snapshotWorktreeTree(path: string): Promise<string | null> {
  const staged = await git(path, ["add", "-A", "--", "."]);
  if (!staged.ok) return null;
  const tree = await git(path, ["write-tree"]);
  const reset = await git(path, ["reset", "--mixed", "HEAD"]);
  const sha = tree.stdout.trim();
  return tree.ok && reset.ok && /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null;
}

let cleanupValidationHook: (() => void | Promise<void>) | null = null;
let cleanupRemovalHook: ((quarantinePath: string) => void | Promise<void>) | null = null;

export function setWorktreeCleanupValidationHookForTests(
  hook: (() => void | Promise<void>) | null,
): void {
  cleanupValidationHook = hook;
}

export function setWorktreeCleanupRemovalHookForTests(
  hook: ((quarantinePath: string) => void | Promise<void>) | null,
): void {
  cleanupRemovalHook = hook;
}

let quarantineSeq = 0;

async function restoreQuarantinedWorktree(
  repoRoot: string,
  quarantinePath: string,
  path: string,
  baseline: WorktreeBaseline,
): Promise<void> {
  await git(quarantinePath, ["reset", "--mixed", baseline.head]);
  await git(repoRoot, ["worktree", "move", quarantinePath, path]);
}

async function sealWorktreeForRemoval(
  path: string,
  branch: string,
  baseline: WorktreeBaseline,
): Promise<boolean> {
  const staged = await git(path, ["add", "-A", "--", "."]);
  if (!staged.ok) return false;
  const tree = await git(path, ["write-tree"]);
  if (!tree.ok || tree.stdout.trim() !== baseline.tree) return false;
  const commit = await git(path, [
    "-c",
    "user.name=Otherside",
    "-c",
    "user.email=worktree@localhost",
    "commit-tree",
    tree.stdout.trim(),
    "-p",
    baseline.head,
    "-m",
    "Temporary worktree cleanup seal",
  ]);
  if (!commit.ok || commit.stdout.trim().length === 0) return false;
  return (
    await git(path, ["update-ref", `refs/heads/${branch}`, commit.stdout.trim(), baseline.head])
  ).ok;
}

async function removeWorktree(
  repoRoot: string,
  path: string,
  branch: string,
  baseline: WorktreeBaseline,
): Promise<boolean> {
  await cleanupValidationHook?.();
  // Fail closed: never tear down a worktree another live run still holds a lease
  // on. The owning run releases its own lease before cleanup, so this only trips
  // for a foreign live holder (e.g. the pruner racing a just-started agent).
  if (await isWorktreeLeaseLive(path)) return false;
  if (!(await matchesBaseline(path, baseline))) return false;
  quarantineSeq += 1;
  const quarantinePath = `${path}.removing-${process.pid}-${quarantineSeq}`;
  const moved = await git(repoRoot, ["worktree", "move", path, quarantinePath]);
  if (!moved.ok) return false;
  if (
    !(await matchesBaseline(quarantinePath, baseline)) ||
    !(await sealWorktreeForRemoval(quarantinePath, branch, baseline))
  ) {
    await restoreQuarantinedWorktree(repoRoot, quarantinePath, path, baseline);
    return false;
  }
  await cleanupRemovalHook?.(quarantinePath);
  // Prefer git's non-force removal so a post-seal write (race) is preserved.
  // On Windows, long-path leftovers or briefly locked files can make remove fail
  // even when the tree is still baseline-identical — only then fall back to
  // --force / filesystem delete. Never force-delete when the tree drifted
  // (valuable agent work must survive). Compare write-tree to baseline.tree
  // (not the fingerprint): seal advances HEAD, which would make a fingerprint
  // recheck look "dirty" even when the working tree is unchanged.
  let removed = await git(repoRoot, ["worktree", "remove", quarantinePath]);
  if (!removed.ok) {
    const staged = await git(quarantinePath, ["add", "-A", "--", "."]);
    const tree = staged.ok ? await git(quarantinePath, ["write-tree"]) : { ok: false, stdout: "" };
    const contentUnchanged = tree.ok && tree.stdout.trim() === baseline.tree;
    if (!contentUnchanged) {
      await restoreQuarantinedWorktree(repoRoot, quarantinePath, path, baseline);
      return false;
    }
    removed = await git(repoRoot, ["worktree", "remove", "--force", quarantinePath]);
    if (!removed.ok) {
      await removeDirRobust(quarantinePath);
      await git(repoRoot, ["worktree", "prune"]);
    }
    if ((await pathExists(quarantinePath)) || (await pathExists(path))) {
      if (await pathExists(quarantinePath)) {
        await restoreQuarantinedWorktree(repoRoot, quarantinePath, path, baseline);
      }
      return false;
    }
  }
  return (await git(repoRoot, ["branch", "-D", branch])).ok;
}

async function tryPruneOne(opts: {
  repoRoot: string;
  worktreesDir: string;
  slug: string;
  cutoff: number;
  activeWorktree: string | null;
}): Promise<boolean> {
  const wtPath = join(opts.worktreesDir, opts.slug);
  if (opts.activeWorktree !== null && resolve(wtPath) === opts.activeWorktree) return false;
  try {
    const info = await stat(wtPath);
    if (info.mtimeMs >= opts.cutoff) return false;
  } catch {
    return false;
  }
  // A live run holds a lease for its whole lifetime — never reclaim it even if
  // the directory mtime aged past the cutoff.
  if (await isWorktreeLeaseLive(wtPath)) return false;
  const baseline = await readBaseline(wtPath);
  if (baseline === null || !(await matchesBaseline(wtPath, baseline))) return false;
  return withWorktreeLock(wtPath, () =>
    removeWorktree(opts.repoRoot, wtPath, `otherside/agent/${opts.slug}`, baseline),
  );
}

export async function pruneOrphanWorktrees(opts: { cwd: string; cutoff: number }): Promise<number> {
  const repoRoot = await canonicalGitRoot(opts.cwd);
  if (repoRoot === null) return 0;
  const activeWorktree = await activeWorktreeRoot(opts.cwd);
  const worktreesDir = join(repoRoot, ".otherside", "worktrees");
  let entries: string[];
  try {
    entries = await readdir(worktreesDir);
  } catch {
    return 0;
  }
  const slugs = entries.filter((name) => ORPHAN_SLUG_PATTERN.test(name));
  const results = await Promise.all(
    slugs.map((slug) =>
      tryPruneOne({ repoRoot, worktreesDir, slug, cutoff: opts.cutoff, activeWorktree }),
    ),
  );
  const removed = results.filter(Boolean).length;
  if (removed > 0) await git(repoRoot, ["worktree", "prune"]);
  return removed;
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

function worktreeHandle(input: {
  path: string;
  branch: string;
  repoRoot: string;
  baseline: WorktreeBaseline | null;
  warning?: string;
}): Worktree {
  const { path, branch, repoRoot, baseline, warning } = input;
  return {
    path,
    branch,
    ...(warning !== undefined ? { warning } : {}),
    async cleanup() {
      if (baseline === null || !(await matchesBaseline(path, baseline))) {
        return { deleted: false };
      }
      return {
        deleted: await withWorktreeLock(path, () =>
          removeWorktree(repoRoot, path, branch, baseline),
        ),
      };
    },
  };
}

async function existingWorktreeMatches(
  path: string,
  branch: string,
  commonRepoRoot: string,
): Promise<boolean> {
  const [root, currentBranch] = await Promise.all([
    canonicalGitRoot(path),
    git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
  ]);
  return root === commonRepoRoot && currentBranch.ok && currentBranch.stdout.trim() === branch;
}

const worktreeLocks = new Map<string, Promise<void>>();
const FILESYSTEM_LOCK_TIMEOUT_MS = 30_000;
const FILESYSTEM_LOCK_STALE_MS = 60 * 60 * 1000;

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function acquireFilesystemLock(key: string): Promise<() => Promise<void>> {
  const lockPath = `${key}.lock`;
  const ownerPath = join(lockPath, "owner");
  const token = randomUUID();
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + FILESYSTEM_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockPath);
      // Publish an ownership token so a superseded holder — one whose lock was
      // taken as stale and re-created by another process — cannot delete the new
      // owner's lock when it finally releases.
      let ownershipPublished = true;
      try {
        await writeFile(ownerPath, token, "utf-8");
      } catch {
        ownershipPublished = false;
      }
      return async () => {
        if (!ownershipPublished) {
          await rm(lockPath, { recursive: true, force: true });
          return;
        }
        try {
          if ((await readFile(ownerPath, "utf-8")) === token) {
            await rm(lockPath, { recursive: true, force: true });
          }
        } catch {}
      };
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > FILESYSTEM_LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) {
        throw new Error(`worktree isolation: timed out waiting for lock ${lockPath}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function withWorktreeLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = worktreeLocks.get(key) ?? Promise.resolve();
  let releaseLocal = (): void => {};
  const current = new Promise<void>((resolve) => {
    releaseLocal = resolve;
  });
  const tail = previous.then(() => current);
  worktreeLocks.set(key, tail);
  await previous;
  let releaseFilesystem: (() => Promise<void>) | null = null;
  try {
    releaseFilesystem = await acquireFilesystemLock(key);
    return await action();
  } finally {
    await releaseFilesystem?.();
    releaseLocal();
    if (worktreeLocks.get(key) === tail) worktreeLocks.delete(key);
  }
}

// A creation that fails after `git worktree add` must leave nothing reusable:
// a linked worktree without a published baseline is a torn overlay that the
// next stable-key call would otherwise adopt and run against.
async function rollbackWorktreeCreation(
  repoRoot: string,
  path: string,
  branch: string,
): Promise<void> {
  await git(repoRoot, ["worktree", "remove", "--force", path]);
  await git(repoRoot, ["branch", "-D", branch]);
  await removeDirRobust(path);
  await git(repoRoot, ["worktree", "prune"]);
}

export async function createWorktree(cwd: string, agentId: string): Promise<Worktree | null> {
  const commonRepoRoot = await canonicalGitRoot(cwd);
  if (commonRepoRoot === null) return null;
  const slug = worktreeSlug(agentId);
  const key = join(commonRepoRoot, ".otherside", "worktrees", slug);
  return withWorktreeLock(key, () => createWorktreeLocked(cwd, slug, commonRepoRoot));
}

async function createWorktreeLocked(
  cwd: string,
  slug: string,
  commonRepoRoot: string,
): Promise<Worktree | null> {
  const activeSourceRoot = await activeWorktreeRoot(cwd);
  if (activeSourceRoot === null) return null;
  const cwdReal = await realpath(cwd);
  const activeSourceRootReal = await realpath(activeSourceRoot);
  if (!isPathWithinRoot(activeSourceRootReal, cwdReal)) {
    throw new Error(
      `worktree isolation: cwd ${cwdReal} is outside the resolved repo ${activeSourceRootReal}`,
    );
  }

  const nestedRepos = await findNestedRepos(activeSourceRoot);
  const warning =
    nestedRepos.length > 0
      ? `nested repos are NOT materialized: ${nestedRepos.join(", ")}`
      : undefined;
  const path = join(commonRepoRoot, ".otherside", "worktrees", slug);
  const branch = `otherside/agent/${slug}`;

  try {
    const existing = await lstat(path);
    if (
      existing.isSymbolicLink() ||
      !(await existingWorktreeMatches(path, branch, commonRepoRoot))
    ) {
      throw new Error(
        `worktree isolation: existing path is not the expected linked worktree: ${path}`,
      );
    }
    const baseline = await readBaseline(path);
    try {
      const now = new Date();
      await utimes(path, now, now);
    } catch {}
    return worktreeHandle({
      path,
      branch,
      repoRoot: commonRepoRoot,
      baseline,
      ...(warning !== undefined ? { warning } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("worktree isolation:")) throw error;
  }

  await mkdir(dirname(path), { recursive: true });
  const sourceHead = await git(activeSourceRoot, ["rev-parse", "HEAD"]);
  if (!sourceHead.ok || sourceHead.stdout.trim().length === 0) return null;
  const added = await git(commonRepoRoot, [
    "worktree",
    "add",
    "-B",
    branch,
    path,
    sourceHead.stdout.trim(),
  ]);
  if (!added.ok) return null;

  // The linked worktree now physically exists. Any setup failure past this point
  // must roll it back so a torn overlay never survives as a reusable worktree —
  // a published baseline is the creation's completion marker.
  try {
    await replicateDirtyChanges(activeSourceRoot, path, nestedRepos);
    const head = await git(path, ["rev-parse", "HEAD"]);
    const fingerprint = await calculateFingerprint(path);
    const tree = await snapshotWorktreeTree(path);
    const baseline: WorktreeBaseline | null =
      head.ok && head.stdout.trim().length > 0 && fingerprint !== null && tree !== null
        ? {
            version: BASELINE_VERSION,
            head: head.stdout.trim(),
            fingerprint,
            tree,
          }
        : null;
    if (baseline === null || !(await writeBaseline(path, baseline))) {
      throw new Error("worktree isolation: failed to establish the worktree baseline");
    }
    return worktreeHandle({
      path,
      branch,
      repoRoot: commonRepoRoot,
      baseline,
      ...(warning !== undefined ? { warning } : {}),
    });
  } catch (error) {
    await rollbackWorktreeCreation(commonRepoRoot, path, branch);
    throw error;
  }
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
