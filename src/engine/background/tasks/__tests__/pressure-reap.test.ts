import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { emitQueue } from "@/engine/queue/emit.ts";
import { setRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import { noteInteraction } from "@/kernel/std/state/interaction-clock.ts";
import { completeTask, get, removeTask, startShellTask, startTask } from "../background.ts";
import {
  PRESSURE_REAP_IDLE_MS,
  PRESSURE_REAP_REASON,
  startPressureReap,
} from "../pressure-reap.ts";

const BASE = 1_000_000_000_000;
const IDLE = BASE + PRESSURE_REAP_IDLE_MS + 1;

const emitPressure = (): void => {
  (process as unknown as { emit(event: string): boolean }).emit("memoryPressure");
};

const pressureListenerCount = (): number => process.listenerCount("memoryPressure" as "exit");

let shellSeq = 0;
const createdTasks: string[] = [];
const stops: Array<() => void> = [];

function registerShell(): string {
  shellSeq += 1;
  const id = `reap-shell-${shellSeq}`;
  startShellTask({ shellId: id, command: "sleep 9999", parentToolCallId: `call-${id}` });
  createdTasks.push(id);
  return id;
}

function reap(
  taskId: string,
  opts?: { ownerId?: string; nowMs?: number },
): {
  stop: () => void;
  kills: () => number;
} {
  let kills = 0;
  const stop = startPressureReap({
    taskId,
    ownerId: opts?.ownerId,
    kill: () => {
      kills += 1;
    },
    now: () => opts?.nowMs ?? IDLE,
  });
  stops.push(stop);
  return { stop, kills: () => kills };
}

beforeEach(() => {
  setRuntimeKind("interactive");
  noteInteraction(BASE);
  emitQueue.setTurnActive(false);
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const id of createdTasks.splice(0)) removeTask(id);
  setRuntimeKind(null);
  delete process.env.CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP;
  delete process.env.OTHERSIDE_DISABLE_BG_SHELL_PRESSURE_REAP;
});

describe("background-shell pressure reap", () => {
  it("kills and notifies an idle running shell on memory pressure", () => {
    const id = registerShell();
    const handle = reap(id);
    emitPressure();
    expect(handle.kills()).toBe(1);
    const task = get(id);
    expect(task?.status).toBe("killed");
    expect(task?.notified).toBe(true);
    expect(task?.result?.content).toBe(PRESSURE_REAP_REASON);
  });

  it("skips when the user interacted inside the idle window", () => {
    const id = registerShell();
    const handle = reap(id, { nowMs: BASE + PRESSURE_REAP_IDLE_MS - 1 });
    emitPressure();
    expect(handle.kills()).toBe(0);
    expect(get(id)?.status).toBe("running");
  });

  it("skips while a turn is active, then reaps once it ends", () => {
    const id = registerShell();
    const handle = reap(id);
    emitQueue.setTurnActive(true);
    emitPressure();
    expect(handle.kills()).toBe(0);
    emitQueue.setTurnActive(false);
    emitPressure();
    expect(handle.kills()).toBe(1);
  });

  it("skips while an agent task is running", () => {
    const id = registerShell();
    const agent = startTask({ parentToolCallId: "call-reap-agent", agentName: "worker" });
    createdTasks.push(agent.id);
    const handle = reap(id);
    emitPressure();
    expect(handle.kills()).toBe(0);
    removeTask(agent.id);
    emitPressure();
    expect(handle.kills()).toBe(1);
  });

  it("skips a task that is no longer running", () => {
    const id = registerShell();
    const handle = reap(id);
    completeTask(id, { content: "(exit 0)", isError: false, exitCode: 0 });
    emitPressure();
    expect(handle.kills()).toBe(0);
    expect(get(id)?.status).toBe("completed");
  });

  it("never subscribes for agent-owned shells", () => {
    const id = registerShell();
    const before = pressureListenerCount();
    const handle = reap(id, { ownerId: "agent-1" });
    expect(pressureListenerCount()).toBe(before);
    emitPressure();
    expect(handle.kills()).toBe(0);
  });

  it.each([
    "CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP",
    "OTHERSIDE_DISABLE_BG_SHELL_PRESSURE_REAP",
  ])("never subscribes when %s is set", (envName) => {
    process.env[envName] = "1";
    const id = registerShell();
    const before = pressureListenerCount();
    const handle = reap(id);
    expect(pressureListenerCount()).toBe(before);
    emitPressure();
    expect(handle.kills()).toBe(0);
  });

  it("never subscribes outside an interactive session", () => {
    setRuntimeKind("print");
    const id = registerShell();
    const before = pressureListenerCount();
    const handle = reap(id);
    expect(pressureListenerCount()).toBe(before);
    emitPressure();
    expect(handle.kills()).toBe(0);
  });

  it("stops listening once unsubscribed", () => {
    const id = registerShell();
    const handle = reap(id);
    handle.stop();
    emitPressure();
    expect(handle.kills()).toBe(0);
    expect(get(id)?.status).toBe("running");
  });
});
