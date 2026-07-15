/**
 * Allocator lever — PROVISIONAL, under evaluation (docs/MEMORY_LEAK.md §1.9).
 *
 * JSC's bundled allocator pins freed pages inside partially-occupied regions
 * on heavy multi-agent workloads (footprint ratchets to GBs while the live JS
 * heap stays flat). Launching the process with `Malloc` present in the environ
 * routes all bmalloc/libpas allocation through the system malloc, which
 * returns large freed blocks to the OS. The env must exist BEFORE the runtime
 * initializes, and the binary IS the runtime — so the only injection point is
 * an in-place re-exec of ourselves at the earliest boot moment.
 *
 * Opt-in while provisional: OTHERSIDE_ALLOC_LEVER=1. Trade-off (accepted for a
 * local CLI): the system-malloc path disables Gigacage/TZone hardening.
 */
import { basename } from "node:path";
import { DEVTOOL_SETTINGS } from "@/devtools/settings.ts";
import { isEnvTruthy } from "@/kernel/std/proc/env.ts";

const REEXEC_MARKER = "OTHERSIDE_ALLOC_LEVER_DONE";
const OPT_IN = DEVTOOL_SETTINGS.allocLever.env;
const OPT_OUT = DEVTOOL_SETTINGS.allocLeverDisabled.env;

type ExecveFn = (file: string, args: string[], env: Record<string, string | undefined>) => void;

export interface AllocLeverDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  execPath: string;
  argv: string[];
  argv0: string;
  execve: ExecveFn | undefined;
}

// bun-types 1.3.14 does not declare execve yet (runtime ships it since 1.3.14).
type ProcessWithExecve = NodeJS.Process & { execve?: ExecveFn };

// WebKit activates the system-heap path on the PRESENCE of any Malloc* var,
// regardless of value — a user-set var means the choice was already made.
export function isSystemHeapActive(env: Record<string, string | undefined> = process.env): boolean {
  return Object.keys(env).some((key) => key.startsWith("Malloc"));
}

export function createAllocLeverGuard(deps: AllocLeverDeps): () => void {
  const { platform, env, execPath, argv, argv0, execve } = deps;

  const isCompiledBinary = () => basename(execPath) !== "bun";

  return () => {
    if (platform === "win32") return;
    if (env[REEXEC_MARKER]) return;
    if (!isEnvTruthy(env[OPT_IN])) return;
    if (isEnvTruthy(env[OPT_OUT])) return;
    if (isSystemHeapActive(env)) return;
    if (!isCompiledBinary()) return;
    if (typeof execve !== "function") return;

    // Compiled-binary argv is ["bun", "/$bunfs/root/<entry>", ...userArgs].
    try {
      execve(execPath, [argv0, ...argv.slice(2)], {
        ...env,
        Malloc: "1",
        [REEXEC_MARKER]: "1",
      });
    } catch {
      // A failed exec leaves this process intact — run without the lever.
    }
  };
}

export const maybeReexecWithAllocLever = (): void =>
  createAllocLeverGuard({
    platform: process.platform,
    env: process.env,
    execPath: process.execPath,
    argv: process.argv,
    argv0: process.argv0,
    execve: (process as ProcessWithExecve).execve,
  })();
