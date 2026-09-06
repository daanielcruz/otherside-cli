import { AsyncLocalStorage } from "node:async_hooks";
import { expandPluginRoot, PLUGIN_ROOT_ENV } from "@/kernel/std/fs/plugin-root.ts";
import { shellCommand } from "@/kernel/std/proc/shell.ts";
import {
  type AgentHookEntry,
  type HookEntry,
  isAgentHook,
  isHttpHook,
  isPromptHook,
} from "@/kernel/std/types/hook-entry.ts";
import { type EventCtx, envFor } from "./events.ts";
import { payloadJsonFor } from "./payload.ts";
import { hookStopReason, hookStopsFlow } from "./response.ts";
import { hookTimeoutMs } from "./timeout.ts";

const OUTPUT_CAP_BYTES = 64 * 1024;
const GRACE_PERIOD_MS = 2_000;

export type HookOutcome =
  | { kind: "ok"; stdout: string; stderr: string; exit: number }
  | { kind: "non_zero_exit"; code: number; stdout: string; stderr: string }
  | { kind: "timeout" }
  | { kind: "spawn_failed"; error: string }
  | { kind: "prompt_passed" }
  // Generic "this hook blocked the flow" outcome: a blocked prompt-hook
  // classification, or an exit-0 hook whose JSON stdout carried `continue:false`.
  | { kind: "prompt_blocked"; reason: string };

export interface AgentHookRequest {
  entry: AgentHookEntry;
  event: EventCtx;
  prompt: string;
  timeoutMs: number;
}

export type AgentHookRunner = (
  request: AgentHookRequest,
) => Promise<{ ok: boolean; reason?: string }>;

const agentHookRunners = new Map<string, AgentHookRunner>();
const agentHookExecution = new AsyncLocalStorage<boolean>();

export function registerAgentHookRunner(sessionId: string, runner: AgentHookRunner): () => void {
  agentHookRunners.set(sessionId, runner);
  return () => {
    if (agentHookRunners.get(sessionId) === runner) agentHookRunners.delete(sessionId);
  };
}

export function _resetAgentHookRunnersForTests(): void {
  agentHookRunners.clear();
}

export async function fireEntry(
  entry: HookEntry,
  ctx: EventCtx,
  timeoutMsOverride?: number,
): Promise<HookOutcome> {
  if (isPromptHook(entry)) {
    return {
      kind: "spawn_failed",
      error: "prompt-type hook fired without classifier — wire firePromptHook",
    };
  }
  if (isAgentHook(entry)) {
    if (agentHookExecution.getStore() === true) return { kind: "prompt_passed" };
    return agentHookExecution.run(true, () => fireAgentHook(entry, ctx, timeoutMsOverride));
  }
  if (isHttpHook(entry)) return fireHttpHook(entry, ctx, timeoutMsOverride);
  const timeoutMs = timeoutMsOverride ?? hookTimeoutMs(entry, ctx.kind);
  const pluginRoot = entry.pluginRoot;
  const command = pluginRoot ? expandPluginRoot(entry.command, pluginRoot) : entry.command;
  const pluginEnv = pluginRoot ? { [PLUGIN_ROOT_ENV]: pluginRoot } : {};
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(shellCommand(command), {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...pluginEnv, ...envFor(ctx) },
    });
  } catch (e) {
    return { kind: "spawn_failed", error: e instanceof Error ? e.message : String(e) };
  }
  writeStdinPayload(proc, payloadJsonFor(ctx));

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
    if (hookStopsFlow(race.stdout)) {
      return { kind: "prompt_blocked", reason: hookStopReason(race.stdout) };
    }
    return { kind: "ok", stdout: race.stdout, stderr: race.stderr, exit: 0 };
  }
  return {
    kind: "non_zero_exit",
    code: race.exit,
    stdout: race.stdout,
    stderr: race.stderr,
  };
}

async function fireAgentHook(
  entry: AgentHookEntry,
  ctx: EventCtx,
  timeoutMsOverride?: number,
): Promise<HookOutcome> {
  const sessionId = (ctx.ctx as { sessionId?: unknown }).sessionId;
  const runner = typeof sessionId === "string" ? agentHookRunners.get(sessionId) : undefined;
  if (!runner) return { kind: "spawn_failed", error: "agent hook runner is unavailable" };
  const jsonInput = payloadJsonFor(ctx);
  const prompt = entry.prompt.includes("$ARGUMENTS")
    ? entry.prompt.replaceAll("$ARGUMENTS", jsonInput)
    : `${entry.prompt}\n\nARGUMENTS: ${jsonInput}`;
  try {
    const result = await runner({
      entry,
      event: ctx,
      prompt,
      timeoutMs: timeoutMsOverride ?? (entry.timeout ?? 60) * 1_000,
    });
    return result.ok
      ? { kind: "prompt_passed" }
      : { kind: "prompt_blocked", reason: result.reason ?? "Agent hook condition was not met" };
  } catch (error) {
    return { kind: "spawn_failed", error: error instanceof Error ? error.message : String(error) };
  }
}

async function fireHttpHook(
  entry: Extract<HookEntry, { type: "http" }>,
  ctx: EventCtx,
  timeoutMsOverride?: number,
): Promise<HookOutcome> {
  const controller = new AbortController();
  const timeoutMs = timeoutMsOverride ?? (entry.timeout ?? 600) * 1_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(entry.url, {
      method: "POST",
      headers: httpHookHeaders(entry),
      body: payloadJsonFor(ctx),
      redirect: "manual",
      signal: controller.signal,
    });
    const stdout = (await response.text()).slice(0, OUTPUT_CAP_BYTES);
    if (!response.ok) {
      return { kind: "non_zero_exit", code: response.status, stdout, stderr: "" };
    }
    if (hookStopsFlow(stdout)) {
      return { kind: "prompt_blocked", reason: hookStopReason(stdout) };
    }
    return { kind: "ok", stdout, stderr: "", exit: 0 };
  } catch (error) {
    if (controller.signal.aborted) return { kind: "timeout" };
    return { kind: "spawn_failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function httpHookHeaders(entry: Extract<HookEntry, { type: "http" }>): Record<string, string> {
  const allowed = new Set(entry.allowedEnvVars ?? []);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  for (const [name, template] of Object.entries(entry.headers ?? {})) {
    headers[name] = template
      .replace(/\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g, (_, braced, plain) => {
        const key = String(braced ?? plain);
        return allowed.has(key) ? (process.env[key] ?? "") : "";
      })
      .replace(/[\r\n\0]/g, "");
  }
  return headers;
}

interface StdinSink {
  write(data: string): unknown;
  end(): unknown;
}

// The payload is buffered and flushed asynchronously, so a hook that never
// reads stdin cannot stall the runner; a closed pipe surfaces as a rejected
// flush, which is swallowed here rather than escaping as an unhandled EPIPE.
function writeStdinPayload(proc: unknown, json: string): void {
  const sink = (proc as { stdin?: unknown } | null)?.stdin as StdinSink | null | undefined;
  if (!sink || typeof sink.write !== "function" || typeof sink.end !== "function") return;
  try {
    swallowRejection(sink.write(json));
    swallowRejection(sink.end());
  } catch {}
}

function swallowRejection(result: unknown): void {
  if (!result || typeof (result as PromiseLike<unknown>).then !== "function") return;
  void Promise.resolve(result).catch(() => {});
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
