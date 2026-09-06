import { dirname, resolve } from "node:path";

export async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
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

export async function gitBytes(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: Uint8Array }> {
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

export async function gitApply(cwd: string, patch: Uint8Array): Promise<boolean> {
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

export const UNTRACKED_FILES_ARGS = [
  "ls-files",
  "--others",
  "--exclude-standard",
  "-z",
  "--",
  ".",
  ":(exclude).otherside/worktrees",
  ":(exclude).otherside/worktrees/**",
];

const WORKSPACE_FILES_ARGS = [
  "ls-files",
  "--cached",
  "--others",
  "--exclude-standard",
  "-z",
  "--",
  ".",
  ":(exclude).otherside/worktrees",
  ":(exclude).otherside/worktrees/**",
];

export async function listWorkspaceFiles(cwd: string): Promise<string[]> {
  const result = await git(cwd, WORKSPACE_FILES_ARGS);
  if (!result.ok) return [];
  return result.stdout.split("\0").filter((path) => path.length > 0);
}

export async function canonicalGitRoot(cwd: string): Promise<string | null> {
  const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) return null;
  const dir = common.stdout.trim();
  return dir.length > 0 ? dirname(dir) : null;
}

export async function activeWorktreeRoot(cwd: string): Promise<string | null> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return null;
  const root = top.stdout.trim();
  return root.length > 0 ? resolve(root) : null;
}

export async function privateGitDir(path: string): Promise<string | null> {
  const result = await git(path, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const dir = result.stdout.trim();
  return result.ok && dir.length > 0 ? dir : null;
}
