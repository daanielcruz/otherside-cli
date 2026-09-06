import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { completeTask, get, removeTask, startShellTask } from "../background.ts";
import {
  SUBAGENT_SHELL_CAP_MS,
  SUBAGENT_SHELL_CAP_REASON,
  startSubagentShellCap,
  subagentShellCapMs,
} from "../subagent-shell-cap.ts";

const ENV_KEY = "OTHERSIDE_SUBAGENT_BG_SHELL_TIMEOUT_MS";
const TINY_CAP_MS = 5;
const CAP_SETTLE_MS = 40;
const OWNER_ID = "agent-owner-1";

let shellSequence = 0;
const createdTasks: string[] = [];
const stops: Array<() => void> = [];

function registerShell(ownerId?: string): string {
  shellSequence += 1;
  const id = `cap-shell-${shellSequence}`;
  startShellTask({
    shellId: id,
    command: "sleep 9999",
    parentToolCallId: `call-${id}`,
    ...(ownerId !== undefined ? { ownerId } : {}),
  });
  createdTasks.push(id);
  return id;
}

interface CapHandle {
  stop: () => void;
  kills: () => number;
  expire: () => void;
  scheduledDelayMs: () => number | undefined;
  unrefCalls: () => number;
}

// Arms the cap against a stubbed timer so expiry is triggered on demand and the
// scheduled delay is observable without waiting for it.
function armCap(taskId: string, opts?: { ownerId?: string; capMs?: number }): CapHandle {
  let kills = 0;
  let scheduled: (() => void) | undefined;
  let scheduledDelayMs: number | undefined;
  let unrefCalls = 0;
  const timer = {
    unref: () => {
      unrefCalls += 1;
    },
  } as unknown as ReturnType<typeof setTimeout>;
  const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    delayMs: number,
  ) => {
    scheduled = callback;
    scheduledDelayMs = delayMs;
    return timer;
  }) as unknown as typeof setTimeout);
  try {
    const stop = startSubagentShellCap({
      taskId,
      ownerId: opts?.ownerId ?? OWNER_ID,
      ...(opts?.capMs !== undefined ? { capMs: opts.capMs } : {}),
      kill: () => {
        kills += 1;
      },
    });
    stops.push(stop);
    return {
      stop,
      kills: () => kills,
      expire: () => scheduled?.(),
      scheduledDelayMs: () => scheduledDelayMs,
      unrefCalls: () => unrefCalls,
    };
  } finally {
    setTimeoutSpy.mockRestore();
  }
}

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const id of createdTasks.splice(0)) removeTask(id);
  delete process.env[ENV_KEY];
});

describe("subagent background-shell cap", () => {
  it("kills the shell and marks the task killed once the cap expires", () => {
    const id = registerShell(OWNER_ID);
    const handle = armCap(id);
    handle.expire();
    expect(handle.kills()).toBe(1);
    const task = get(id);
    expect(task?.status).toBe("killed");
    expect(task?.result?.content).toBe(SUBAGENT_SHELL_CAP_REASON);
  });

  it("never arms a cap for a main-session shell", () => {
    const id = registerShell();
    let kills = 0;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    try {
      stops.push(
        startSubagentShellCap({
          taskId: id,
          kill: () => {
            kills += 1;
          },
        }),
      );
      expect(setTimeoutSpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
    expect(kills).toBe(0);
    expect(get(id)?.status).toBe("running");
  });

  it("unrefs the cap timer so it cannot hold the process open", () => {
    const handle = armCap(registerShell(OWNER_ID));
    expect(handle.unrefCalls()).toBe(1);
  });

  it("does not kill a shell that already exited", () => {
    const id = registerShell(OWNER_ID);
    const handle = armCap(id);
    completeTask(id, { content: "(exit 0)", isError: false, exitCode: 0 });
    handle.expire();
    expect(handle.kills()).toBe(0);
    expect(get(id)?.status).toBe("completed");
  });

  it("kills against real timers once a tiny injected cap elapses", async () => {
    const id = registerShell(OWNER_ID);
    let kills = 0;
    stops.push(
      startSubagentShellCap({
        taskId: id,
        ownerId: OWNER_ID,
        capMs: TINY_CAP_MS,
        kill: () => {
          kills += 1;
        },
      }),
    );
    await Bun.sleep(CAP_SETTLE_MS);
    expect(kills).toBe(1);
    expect(get(id)?.status).toBe("killed");
  });

  it("clears the timer when the shell exits naturally", async () => {
    const id = registerShell(OWNER_ID);
    let kills = 0;
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
    try {
      const stop = startSubagentShellCap({
        taskId: id,
        ownerId: OWNER_ID,
        capMs: TINY_CAP_MS,
        kill: () => {
          kills += 1;
        },
      });
      stops.push(stop);
      stop();
      stop();
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeoutSpy.mockRestore();
    }
    await Bun.sleep(CAP_SETTLE_MS);
    expect(kills).toBe(0);
    expect(get(id)?.status).toBe("running");
  });

  it("defaults to one hour and reads a positive integer override", () => {
    expect(SUBAGENT_SHELL_CAP_MS).toBe(3_600_000);
    expect(subagentShellCapMs()).toBe(SUBAGENT_SHELL_CAP_MS);
    process.env[ENV_KEY] = "1500";
    expect(subagentShellCapMs()).toBe(1500);
    process.env[ENV_KEY] = "not-a-number";
    expect(subagentShellCapMs()).toBe(SUBAGENT_SHELL_CAP_MS);
    process.env[ENV_KEY] = "0";
    expect(subagentShellCapMs()).toBe(SUBAGENT_SHELL_CAP_MS);
  });

  it("schedules at the configured cap, or at an injected one when given", () => {
    process.env[ENV_KEY] = "2500";
    expect(armCap(registerShell(OWNER_ID)).scheduledDelayMs()).toBe(2500);
    expect(armCap(registerShell(OWNER_ID), { capMs: TINY_CAP_MS }).scheduledDelayMs()).toBe(
      TINY_CAP_MS,
    );
  });
});
