import { expandPluginRoot, PLUGIN_ROOT_ENV } from "@/kernel/std/fs/plugin-root.ts";
import { shellCommand } from "@/kernel/std/proc/shell.ts";
import { type EventCtx, envFor } from "./events.ts";

const OUTPUT_CAP_BYTES = 64 * 1024;
const GRACE_PERIOD_MS = 2_000;

export interface CommandHookEntry {
  type?: "command";
  matcher: string;
  command: string;
  timeoutMs?: number;
  // Set when the hook came from a plugin manifest: its install dir, used to
  // expand ${CLAUDE_PLUGIN_ROOT} in the command and inject CLAUDE_PLUGIN_ROOT
  // into the spawn env. Undefined for user/project hooks (no injection).
  pluginRoot?: string;
  // Async execution flags (Stop hooks): `async` backgrounds the hook
  // (fire-and-forget); `asyncRewake` backgrounds it AND, when it exits with
  // code 2 on an interactive session, enqueues a rewake task-notification
  // (`rewakeMessage` overrides the body prefix, `rewakeSummary` the summary).
  // Consumed by engine/queue/runtime/stop-hook-rewake.ts.
  async?: boolean;
  asyncRewake?: boolean;
  rewakeMessage?: string;
  rewakeSummary?: string;
}

export interface PromptHookEntry {
  type: "prompt";
  matcher: string;
  prompt: string;
  timeoutMs?: number;
}

export type HookEntry = CommandHookEntry | PromptHookEntry;

export function isCommandHook(entry: HookEntry): entry is CommandHookEntry {
  return entry.type === undefined || entry.type === "command";
}

export function isPromptHook(entry: HookEntry): entry is PromptHookEntry {
  return entry.type === "prompt";
}

export type HookOutcome =
  | { kind: "ok"; stdout: string; stderr: string; exit: number }
  | { kind: "non_zero_exit"; code: number; stdout: string; stderr: string }
  | { kind: "timeout" }
  | { kind: "spawn_failed"; error: string }
  | { kind: "prompt_passed" }
  | { kind: "prompt_blocked"; reason: string };

export async function fireEntry(
  entry: HookEntry,
  ctx: EventCtx,
  timeoutMs: number,
): Promise<HookOutcome> {
  if (isPromptHook(entry)) {
    return {
      kind: "spawn_failed",
      error: "prompt-type hook fired without classifier — wire firePromptHook",
    };
  }
  const pluginRoot = entry.pluginRoot;
  const command = pluginRoot ? expandPluginRoot(entry.command, pluginRoot) : entry.command;
  const pluginEnv = pluginRoot ? { [PLUGIN_ROOT_ENV]: pluginRoot } : {};
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(shellCommand(command), {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...pluginEnv, ...envFor(ctx) },
    });
  } catch (e) {
    return { kind: "spawn_failed", error: e instanceof Error ? e.message : String(e) };
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timer = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => {
      timeoutHandle = null;
      resolve("timeout");
    }, timeoutMs);
  });
  void proc.exited.then(() => {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  });

  const out = proc.stdout instanceof ReadableStream ? proc.stdout : null;
  const err = proc.stderr instanceof ReadableStream ? proc.stderr : null;
  const done = (async () => {
    const [stdout, stderr] = await Promise.all([drainCapped(out), drainCapped(err)]);
    const exit = await proc.exited;
    return { stdout, stderr, exit: typeof exit === "number" ? exit : -1 };
  })();

  const race = await Promise.race([timer, done]);
  if (timeoutHandle !== null) {
    clearTimeout(timeoutHandle);
    timeoutHandle = null;
  }
  if (race === "timeout") {
    proc.kill("SIGTERM");
    let graceHandle: ReturnType<typeof setTimeout> | null = null;
    const grace = new Promise<void>((resolve) => {
      graceHandle = setTimeout(() => {
        graceHandle = null;
        resolve();
      }, GRACE_PERIOD_MS);
    });
    await Promise.race([grace, proc.exited.then(() => undefined)]);
    if (graceHandle !== null) clearTimeout(graceHandle);
    proc.kill("SIGKILL");
    return { kind: "timeout" };
  }

  if (race.exit === 0) {
    return { kind: "ok", stdout: race.stdout, stderr: race.stderr, exit: 0 };
  }
  return {
    kind: "non_zero_exit",
    code: race.exit,
    stdout: race.stdout,
    stderr: race.stderr,
  };
}

async function drainCapped(stream: ReadableStream<Uint8Array> | undefined | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = OUTPUT_CAP_BYTES - total;
      if (remaining <= 0) break;
      const take = Math.min(value.byteLength, remaining);
      chunks.push(value.subarray(0, take));
      total += take;
      if (total >= OUTPUT_CAP_BYTES) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}
