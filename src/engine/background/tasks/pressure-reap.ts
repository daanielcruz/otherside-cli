import { emitQueue } from "@/engine/queue/emit.ts";
import { isEnvTruthy } from "@/kernel/std/env.ts";
import { getRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import { lastInteractionTime } from "@/kernel/std/state/interaction-clock.ts";
import { completeTask, get, list } from "./background.ts";

// When the OS reports memory pressure, a background shell the user abandoned
// in an idle interactive session is reclaimed: the process is killed and the
// task is notified as killed, exactly like a stop. The listener registers
// unconditionally at shell registration; on a runtime whose `process` never
// emits "memoryPressure" it stays inert and costs nothing.
//
// Only main-session shells in an interactive run subscribe: agent-owned
// shells are reclaimed by their owner's lifecycle, and non-interactive runs
// are bounded by their own completion.
export const PRESSURE_REAP_IDLE_MS = 1_800_000;

export const PRESSURE_REAP_REASON = "Stopped under memory pressure";

// "memoryPressure" is emitted by the Bun runtime on OS low-memory signals;
// the bundled process typings predate the event.
interface MemoryPressureEmitter {
  on(event: "memoryPressure", listener: () => void): unknown;
  off(event: "memoryPressure", listener: () => void): unknown;
  emit(event: "memoryPressure"): boolean;
}

function pressureEmitter(): MemoryPressureEmitter {
  return process as unknown as MemoryPressureEmitter;
}

function reapDisabled(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP) ||
    isEnvTruthy(process.env.OTHERSIDE_DISABLE_BG_SHELL_PRESSURE_REAP)
  );
}

function agentWorkActive(): boolean {
  return list().some((task) => task.kind === "agent" && task.status === "running");
}

export interface PressureReapOptions {
  taskId: string;
  // Owning agent id; agent-owned shells never subscribe.
  ownerId?: string | undefined;
  // Kills the shell process itself; the reap then marks the task killed,
  // which notifies through the normal completion path.
  kill: () => void;
  now?: () => number;
}

export function startPressureReap(opts: PressureReapOptions): () => void {
  if (opts.ownerId !== undefined || getRuntimeKind() !== "interactive" || reapDisabled()) {
    return () => {};
  }
  const now = opts.now ?? ((): number => Date.now());
  const handler = (): void => {
    const task = get(opts.taskId);
    if (task === undefined || task.status !== "running" || task.notified) return;
    if (now() - lastInteractionTime() < PRESSURE_REAP_IDLE_MS) return;
    if (emitQueue.isTurnActive()) return;
    if (agentWorkActive()) return;
    opts.kill();
    completeTask(opts.taskId, { content: PRESSURE_REAP_REASON, isError: false, killed: true });
  };
  pressureEmitter().on("memoryPressure", handler);
  let stopped = false;
  return (): void => {
    if (stopped) return;
    stopped = true;
    pressureEmitter().off("memoryPressure", handler);
  };
}
