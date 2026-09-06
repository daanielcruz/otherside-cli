import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { Subprocess } from "bun";
import { taskArtifactDirectory } from "@/engine/background/tasks/output-files.ts";
import {
  ensureSandboxMonitor,
  shouldUseSandbox,
  wrapWithSandbox,
} from "@/engine/sandbox/manager.ts";
import type { OutputProgress, SpillBuffer } from "@/engine/tools/_infra/spill-buffer.ts";
import { isEnvTruthy } from "@/kernel/std/proc/env.ts";
import { isWindows } from "@/kernel/std/proc/platform.ts";
import { extglobDisableCommand, findShell, shellCommand } from "@/kernel/std/proc/shell.ts";
import { getShellSnapshotPath } from "@/kernel/storage/shell-snapshot.ts";
import { bashOutputCap, truncationMarker } from "./output.ts";

export const GRACE_PERIOD_MS = 1_500;
export const POST_EXIT_DRAIN_MS = 100;
export const BASH_PROGRESS_THRESHOLD_MS = 2_000;
export const BASH_PROGRESS_INTERVAL_MS = 1_000;
export const BASH_PROGRESS_TAIL_LINES = 5;
export const BG_OUTPUT_FLUSH_MS = 250;

export function shellQuote(s: string): string {
  if (s.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export function fullTextProgress(text: string): OutputProgress {
  return { tailText: text, spilledChars: 0, spilledNewlines: 0 };
}

function nonInteractiveEnv(): Record<string, string> {
  const base: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    GIT_ASKPASS: "echo",
    GIT_PAGER: "cat",
    PAGER: "cat",
    DEBIAN_FRONTEND: "noninteractive",
    NEEDRESTART_MODE: "a",
    HOMEBREW_NO_AUTO_UPDATE: "1",
    HOMEBREW_NO_INSTALL_CLEANUP: "1",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_AUDIT: "false",
  };
  if (!isWindows() || findShell()) {
    base.SSH_ASKPASS = "/bin/false";
    base.SUDO_ASKPASS = "/bin/false";
  }
  return base;
}

const NON_INTERACTIVE_ENV = nonInteractiveEnv();

interface PrepareExecInput {
  command: string;
  dangerouslyDisableSandbox: boolean;
  cwdFilePath: string | null;
}

export async function prepareExecCommand(
  input: PrepareExecInput,
): Promise<{ execCommand: string; sandboxed: boolean; logTag: string | null; login: boolean }> {
  const { command, dangerouslyDisableSandbox, cwdFilePath } = input;
  const snapshotPath = await getShellSnapshotPath();
  const shellPath = findShell() ?? "/bin/sh";
  const disableExtglob = extglobDisableCommand(shellPath);
  const guard = disableExtglob !== null ? `${disableExtglob} && ` : "";
  const core =
    snapshotPath !== null
      ? `source ${shellQuote(snapshotPath)} && ${guard}${command}`
      : `${guard}${command}`;
  // Merge the command's stderr into stdout at the fd level (`2>&1` on the group)
  // so the model reads one chronologically-interleaved stream. Capture the real
  // exit BEFORE the cwd probe: a trailing `pwd` resets `$?`, masking every
  // non-`exit` failure (false/grep/tsc) to 0. The probe's own noise is dropped.
  const innerCommand =
    cwdFilePath !== null
      ? `{ ${core}\n} 2>&1\n__otherside_exit=$?\npwd -P >| ${shellQuote(cwdFilePath)} 2>/dev/null\nexit $__otherside_exit`
      : `{ ${core}\n} 2>&1`;
  // No snapshot to source → run a login shell so the user's profile loads. Windows
  // snapshots are not supported yet, and Git Bash logout scripts can write terminal
  // control sequences into otherwise exact command output.
  const login = snapshotPath === null && !isWindows();
  const sandboxed = shouldUseSandbox({ command, dangerouslyDisableSandbox });
  if (!sandboxed) return { execCommand: innerCommand, sandboxed: false, logTag: null, login };
  ensureSandboxMonitor();
  const wrap = wrapWithSandbox(innerCommand, shellPath);
  return { execCommand: wrap.wrapped, sandboxed: true, logTag: wrap.logTag, login };
}

export function shellSpawnEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const childEnv = { ...env, ...NON_INTERACTIVE_ENV };
  if (isEnvTruthy(env.OTHERSIDE_REMOTE)) {
    childEnv.BUN_OPTIONS = env.BUN_OPTIONS ? `--smol ${env.BUN_OPTIONS}` : "--smol";
  }
  return childEnv;
}

export function spawnShell(
  execCommand: string,
  opts: { cwd: string; login?: boolean | undefined },
): Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn(shellCommand(execCommand, { login: !!opts.login }), {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: shellSpawnEnvironment(),
    cwd: opts.cwd,
    detached: !isWindows(),
    windowsHide: true,
  });
}

export function killProcessTree(child: Subprocess, signal: "SIGTERM" | "SIGKILL"): void {
  const pid = child.pid;
  if (!isWindows() && typeof pid === "number") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {}
  }
  try {
    child.kill(signal);
  } catch {}
}

export function scheduleKillEscalation(child: Subprocess): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => killProcessTree(child, "SIGKILL"), GRACE_PERIOD_MS);
  void child.exited.then(() => clearTimeout(timer));
  return timer;
}

interface StreamSink {
  buffer: SpillBuffer;
  onChunk?: (chunk: string) => void;
  acceptChunk?: (chunk: string) => boolean;
  childExited?: Promise<number | null>;
}

const EXIT_DRAIN_POLL_MS = 25;

// Read the next chunk, or "exited" once the child has exited and no buffered chunk is
// in flight. The obvious `Promise.race([reader.read(), exitMarker])` LEAKS: `Promise.race`
// attaches a fresh reaction to the long-lived `exitMarker` on every iteration, and a
// reaction on a settled promise pins that promise's resolved value — so it pins every
// chunk's ArrayBuffer to `exitMarker` until the child exits (~0.25 MB/read → GBs on a
// long, slow line-by-line stream). Here we race a value-stripped sentinel instead, so
// no chunk is pinned. When the child has already exited we still give the in-flight
// read a brief grace (a fast command's tail must not be dropped); if it remains stalled,
// the caller's bounded post-exit drain keeps waiting on that same read.
// Structural on purpose: node's and Bun's ReadableStreamDefaultReader types
// disagree (readMany), so nominal reader types fail under one of the two.
type StreamReadResult = { done: boolean; value?: Uint8Array | undefined };
type PendingStreamRead = { pendingRead: Promise<StreamReadResult> };

async function raceReadWithTimeout(
  readPromise: Promise<StreamReadResult>,
  timeoutMs: number,
): Promise<StreamReadResult | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      readPromise,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function readOrExit(
  reader: { read(): Promise<StreamReadResult> },
  exitMarker: Promise<"exited">,
): Promise<StreamReadResult | PendingStreamRead> {
  const readPromise = reader.read();
  const settled = await Promise.race([readPromise.then(() => "read" as const), exitMarker]);
  if (settled === "read") return await readPromise;
  const next = await raceReadWithTimeout(readPromise, EXIT_DRAIN_POLL_MS);
  return next === "timeout" ? { pendingRead: readPromise } : next;
}

export async function drainStream(
  stream: ReadableStream<Uint8Array>,
  sink: StreamSink,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const push = (text: string): void => {
    if (text.length === 0) return;
    if (sink.acceptChunk?.(text) === false) return;
    sink.buffer.append(text);
    sink.onChunk?.(text);
  };
  if (sink.childExited === undefined) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      push(decoder.decode(value, { stream: true }));
    }
    push(decoder.decode());
    return;
  }
  const exitMarker = sink.childExited.then(() => "exited" as const);
  let pendingRead: Promise<StreamReadResult> | null = null;
  while (true) {
    const next = await readOrExit(reader, exitMarker);
    if ("pendingRead" in next) {
      pendingRead = next.pendingRead;
      break;
    }
    if (next.done) {
      push(decoder.decode());
      try {
        reader.releaseLock();
      } catch {}
      return;
    }
    if (next.value) push(decoder.decode(next.value, { stream: true }));
  }
  const deadline = Date.now() + POST_EXIT_DRAIN_MS;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const readPromise = pendingRead ?? reader.read();
    pendingRead = null;
    const next = await raceReadWithTimeout(readPromise, remaining);
    if (next === "timeout") break;
    if (next.done) break;
    if (next.value) push(decoder.decode(next.value, { stream: true }));
  }
  try {
    await reader.cancel();
  } catch {}
  push(decoder.decode());
}

export async function drainStreamToString(
  stream: ReadableStream<Uint8Array>,
  childExited: Promise<number | null>,
  onProgress?: (window: string) => void,
): Promise<string> {
  const cap = bashOutputCap();
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  let head = "";
  let remainingLines = 0;
  let isTruncated = false;

  const countNewlines = (text: string): number => {
    let count = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") count++;
    }
    return count;
  };

  const pushChunk = (chunk: string): void => {
    if (chunk.length === 0) return;
    if (isTruncated) {
      remainingLines += countNewlines(chunk);
    } else {
      head += chunk;
      if (head.length > cap) {
        remainingLines = countNewlines(head.slice(cap)) + 1;
        head = head.slice(0, cap);
        isTruncated = true;
      }
    }
    onProgress?.(head);
  };

  const getResult = (): string => (isTruncated ? head + truncationMarker(remainingLines) : head);

  const exitMarker = childExited.then(() => "exited" as const);
  let pendingRead: Promise<StreamReadResult> | null = null;
  while (true) {
    const next = await readOrExit(reader, exitMarker);
    if ("pendingRead" in next) {
      pendingRead = next.pendingRead;
      break;
    }
    if (next.done) {
      pushChunk(decoder.decode());
      try {
        reader.releaseLock();
      } catch {}
      return getResult();
    }
    if (next.value) pushChunk(decoder.decode(next.value, { stream: true }));
  }
  const deadline = Date.now() + POST_EXIT_DRAIN_MS;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const readPromise = pendingRead ?? reader.read();
    pendingRead = null;
    const next = await raceReadWithTimeout(readPromise, remaining);
    if (next === "timeout") break;
    if (next.done) break;
    if (next.value) pushChunk(decoder.decode(next.value, { stream: true }));
  }
  try {
    await reader.cancel();
  } catch {}
  pushChunk(decoder.decode());
  return getResult();
}

interface TaskLogAppender {
  queueChunk: (chunk: string) => void;
  close: () => void;
}

export function makeTaskLogAppender(outputPath: string): TaskLogAppender {
  try {
    mkdirSync(taskArtifactDirectory(), { recursive: true });
    writeFileSync(outputPath, "", "utf8");
  } catch {}
  const pending: string[] = [];
  let closed = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    if (pending.length === 0) return;
    const chunk = pending.join("");
    pending.length = 0;
    try {
      appendFileSync(outputPath, chunk, "utf8");
    } catch {}
  };
  const queueChunk = (chunk: string): void => {
    if (closed) return;
    pending.push(chunk);
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, BG_OUTPUT_FLUSH_MS);
  };
  const close = (): void => {
    closed = true;
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flush();
  };
  return { queueChunk, close };
}
