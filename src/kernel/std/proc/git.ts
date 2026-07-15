import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

export interface CloneOptions {
  ref?: string;
  sparsePaths?: string[];
}

export interface CloneResult {
  ok: boolean;
  error?: string;
}

export function cloneRepo(url: string, dest: string, opts: CloneOptions = {}): CloneResult {
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }
  const sparsePaths = opts.sparsePaths ?? [];
  const useSparse = sparsePaths.length > 0;
  const args = ["clone", "--depth", "1"];
  if (useSparse) args.push("--filter=blob:none", "--no-checkout");
  else args.push("--recurse-submodules", "--shallow-submodules");
  if (opts.ref) {
    args.push("--branch", opts.ref);
  }
  args.push(url, dest);
  try {
    execFileSync("git", args, { stdio: "pipe" });
    if (useSparse) {
      execFileSync("git", ["-C", dest, "sparse-checkout", "set", "--cone", "--", ...sparsePaths], {
        stdio: "pipe",
      });
      execFileSync("git", ["-C", dest, "checkout", "HEAD"], { stdio: "pipe" });
    }
    return { ok: true };
  } catch (err) {
    rmSync(dest, { recursive: true, force: true });
    const stderr =
      typeof err === "object" && err !== null && "stderr" in err
        ? String((err as { stderr?: unknown }).stderr ?? "")
        : "";
    const message = err instanceof Error ? err.message : "git clone failed";
    return { ok: false, error: stderr.trim() || message };
  }
}
