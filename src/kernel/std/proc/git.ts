import { execFile, execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

export interface CloneOptions {
  ref?: string;
  sparsePaths?: string[];
  timeoutMs?: number;
}

export interface CloneResult {
  ok: boolean;
  error?: string;
}

/** The git invocations one clone takes, in run order. */
function cloneCommands(url: string, dest: string, opts: CloneOptions): string[][] {
  const sparsePaths = opts.sparsePaths ?? [];
  const useSparse = sparsePaths.length > 0;
  const args = ["clone", "--depth", "1"];
  if (useSparse) args.push("--filter=blob:none", "--no-checkout");
  else args.push("--recurse-submodules", "--shallow-submodules");
  if (opts.ref) {
    args.push("--branch", opts.ref);
  }
  args.push(url, dest);
  const commands = [args];
  if (useSparse) {
    commands.push(["-C", dest, "sparse-checkout", "set", "--cone", "--", ...sparsePaths]);
    commands.push(["-C", dest, "checkout", "HEAD"]);
  }
  return commands;
}

function prepareDest(dest: string): void {
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }
}

function cloneFailure(dest: string, err: unknown, timeoutMs?: number): CloneResult {
  rmSync(dest, { recursive: true, force: true });
  const killed =
    typeof err === "object" && err !== null && "killed" in err
      ? (err as { killed?: boolean }).killed === true
      : false;
  if (killed && timeoutMs !== undefined) {
    return { ok: false, error: `git clone timed out after ${Math.round(timeoutMs / 1000)}s` };
  }
  const stderr =
    typeof err === "object" && err !== null && "stderr" in err
      ? String((err as { stderr?: unknown }).stderr ?? "")
      : "";
  const message = err instanceof Error ? err.message : "git clone failed";
  return { ok: false, error: stderr.trim() || message };
}

export function cloneRepoSync(url: string, dest: string, opts: CloneOptions = {}): CloneResult {
  prepareDest(dest);
  try {
    for (const args of cloneCommands(url, dest, opts)) {
      execFileSync("git", args, {
        stdio: "pipe",
        ...(opts.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs }),
      });
    }
    return { ok: true };
  } catch (err) {
    return cloneFailure(dest, err, opts.timeoutMs);
  }
}

/** Same clone off the event loop, so interactive callers keep rendering. */
export async function cloneRepo(
  url: string,
  dest: string,
  opts: CloneOptions = {},
): Promise<CloneResult> {
  prepareDest(dest);
  try {
    for (const args of cloneCommands(url, dest, opts)) {
      await execGit(args, opts.timeoutMs);
    }
    return { ok: true };
  } catch (err) {
    return cloneFailure(dest, err, opts.timeoutMs);
  }
}

function execGit(args: string[], timeoutMs?: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      args,
      timeoutMs === undefined ? {} : { timeout: timeoutMs },
      (err, _stdout, stderr) => {
        if (err) {
          Reflect.set(err, "stderr", stderr);
          reject(err);
          return;
        }
        resolvePromise();
      },
    );
  });
}
