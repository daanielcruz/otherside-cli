import { createHash } from "node:crypto";
import { lstat, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, gitBytes, privateGitDir, UNTRACKED_FILES_ARGS } from "./worktree-git.ts";

const BASELINE_FILENAME = "otherside-base.json";
export const BASELINE_VERSION = 2;

export interface WorktreeBaseline {
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

export async function calculateFingerprint(cwd: string): Promise<string | null> {
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

export async function readBaseline(path: string): Promise<WorktreeBaseline | null> {
  const gitDir = await privateGitDir(path);
  if (gitDir === null) return null;
  try {
    return parseBaseline(await readFile(join(gitDir, BASELINE_FILENAME), "utf-8"));
  } catch {
    return null;
  }
}

export async function writeBaseline(path: string, baseline: WorktreeBaseline): Promise<boolean> {
  const gitDir = await privateGitDir(path);
  if (gitDir === null) return false;
  try {
    await writeFile(join(gitDir, BASELINE_FILENAME), JSON.stringify(baseline), "utf-8");
    return true;
  } catch {
    return false;
  }
}

export async function matchesBaseline(path: string, baseline: WorktreeBaseline): Promise<boolean> {
  const head = await git(path, ["rev-parse", "HEAD"]);
  if (!head.ok || head.stdout.trim() !== baseline.head) return false;
  const fingerprint = await calculateFingerprint(path);
  return fingerprint !== null && fingerprint === baseline.fingerprint;
}

export async function snapshotWorktreeTree(path: string): Promise<string | null> {
  const staged = await git(path, ["add", "-A", "--", "."]);
  if (!staged.ok) return null;
  const tree = await git(path, ["write-tree"]);
  const reset = await git(path, ["reset", "--mixed", "HEAD"]);
  const sha = tree.stdout.trim();
  return tree.ok && reset.ok && /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null;
}
