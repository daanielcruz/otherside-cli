import { appendShellOutput, listRunning, subscribe } from "@/engine/background/tasks/background.ts";
import { pollBackground } from "@/engine/tools/builtins/bash.ts";

const DEFAULT_TICK_MS = 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;
let tickMs = DEFAULT_TICK_MS;

function disarm(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

function syncTimer(): void {
  const hasRunningShell = listRunning().some((task) => task.kind === "shell");
  if (!hasRunningShell) {
    disarm();
    return;
  }
  if (timer !== null) return;
  timer = setInterval(pollOnce, tickMs);
  (timer as { unref?: () => void } | null)?.unref?.();
}

function pollOnce(): void {
  const runningShells = listRunning().filter((task) => task.kind === "shell");
  if (runningShells.length === 0) {
    disarm();
    return;
  }
  for (const task of runningShells) {
    const polled = pollBackground(task.id, null);
    if ("error" in polled) continue;
    const chunk = polled.stdout + polled.stderr;
    if (chunk.length > 0) appendShellOutput(task.id, chunk);
  }
}

export function startSharedOutputPoller(intervalMs = DEFAULT_TICK_MS): void {
  if (unsubscribe !== null) return;
  tickMs = intervalMs;
  unsubscribe = subscribe(syncTimer);
  syncTimer();
}

export function stopSharedOutputPoller(): void {
  unsubscribe?.();
  unsubscribe = null;
  disarm();
}

export function pollSharedOutputOnce(): void {
  pollOnce();
}
