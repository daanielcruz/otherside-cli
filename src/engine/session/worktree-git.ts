import { dirname } from "node:path";

export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!r.ok) return null;
  const b = r.stdout.trim();
  return b.length > 0 ? b : null;
}

export async function revParse(cwd: string, ref: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", ref]);
  if (!r.ok) return null;
  const sha = r.stdout.trim();
  return sha.length > 0 ? sha : null;
}

export async function canonicalGitRoot(cwd: string): Promise<string | null> {
  const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) return null;
  const dir = common.stdout.trim();
  return dir.length > 0 ? dirname(dir) : null;
}

export async function git(
  cwd: string,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer =
      opts?.timeoutMs !== undefined
        ? setTimeout(() => {
            proc.kill();
          }, opts.timeoutMs)
        : null;
    timer?.unref?.();
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (timer !== null) clearTimeout(timer);
    return { ok: code === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}
