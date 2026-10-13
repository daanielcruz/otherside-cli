import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  completeTask,
  get,
  markTaskNotified,
  removeTask,
  startShellTask,
  startTask,
} from "../background.ts";
import {
  SHELL_DEADLINE_REASON,
  shellDeadlineNotice,
  startShellDeadline,
} from "../shell-deadline.ts";

const TINY_LIMIT_MS = 5;
const LIMIT_SETTLE_MS = 40;
const UNREACHED_LIMIT_MS = 60_000;

const createdTasks: string[] = [];
const stops: Array<() => void> = [];
const originalPlatform = process.platform;

function registerShell(): string {
  const id = `deadline-shell-${crypto.randomUUID()}`;
  startShellTask({ shellId: id, command: "<command>", parentToolCallId: `call-${id}` });
  createdTasks.push(id);
  return id;
}

function armDeadline(taskId: string, limitMs = TINY_LIMIT_MS): { kills: () => number } {
  let kills = 0;
  stops.push(
    startShellDeadline({
      taskId,
      limitMs,
      kill: () => {
        kills += 1;
      },
    }),
  );
  return { kills: () => kills };
}

function unrefCallsOnPlatform(platform: NodeJS.Platform): number {
  Object.defineProperty(process, "platform", { value: platform });
  let unrefCalls = 0;
  const timer = {
    unref: () => {
      unrefCalls += 1;
    },
  } as unknown as ReturnType<typeof setTimeout>;
  const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
    (() => timer) as unknown as typeof setTimeout,
  );
  try {
    armDeadline(registerShell(), UNREACHED_LIMIT_MS);
  } finally {
    setTimeoutSpy.mockRestore();
  }
  return unrefCalls;
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  for (const stop of stops.splice(0)) stop();
  for (const id of createdTasks.splice(0)) removeTask(id);
});

describe("shell deadline", () => {
  it("kills a shell still running when the limit passes", async () => {
    const handle = armDeadline(registerShell());
    await Bun.sleep(LIMIT_SETTLE_MS);
    expect(handle.kills()).toBe(1);
  });

  it("marks the stopped task killed at its deadline", async () => {
    const id = registerShell();
    armDeadline(id);
    await Bun.sleep(LIMIT_SETTLE_MS);
    const task = get(id);
    expect(task?.status).toBe("killed");
    expect(task?.stopCause).toBe("deadline");
    expect(task?.result?.content).toBe(SHELL_DEADLINE_REASON);
  });

  it("leaves a shell that already exited alone", async () => {
    const id = registerShell();
    const handle = armDeadline(id);
    completeTask(id, { content: "(exit 0)", isError: false, exitCode: 0 });
    await Bun.sleep(LIMIT_SETTLE_MS);
    expect(handle.kills()).toBe(0);
    expect(get(id)?.status).toBe("completed");
  });

  it("leaves an already notified task alone", async () => {
    const id = registerShell();
    markTaskNotified(id);
    const handle = armDeadline(id);
    await Bun.sleep(LIMIT_SETTLE_MS);
    expect(handle.kills()).toBe(0);
    expect(get(id)?.status).toBe("running");
  });

  it("leaves a task that is not backgrounded alone", async () => {
    const task = startTask({
      parentToolCallId: `call-${crypto.randomUUID()}`,
      agentName: "<agent>",
      description: "<description>",
      isBackgrounded: false,
    });
    createdTasks.push(task.id);
    const handle = armDeadline(task.id);
    await Bun.sleep(LIMIT_SETTLE_MS);
    expect(handle.kills()).toBe(0);
    expect(get(task.id)?.status).toBe("running");
  });

  it("does not fire once stopped", async () => {
    const id = registerShell();
    const handle = armDeadline(id);
    for (const stop of stops.splice(0)) stop();
    await Bun.sleep(LIMIT_SETTLE_MS);
    expect(handle.kills()).toBe(0);
    expect(get(id)?.status).toBe("running");
  });

  it("unrefs its timer so it cannot hold the process open", () => {
    expect(unrefCallsOnPlatform("darwin")).toBe(1);
  });

  it("leaves its timer ref'd on Windows so it still fires", () => {
    expect(unrefCallsOnPlatform("win32")).toBe(0);
  });
});

describe("shellDeadlineNotice", () => {
  it("names the limit in minutes", () => {
    expect(shellDeadlineNotice(1_800_000)).toBe(
      "If it is still running after 30m in the background, it will be stopped and you will be notified.",
    );
  });

  it("names the limit in hours", () => {
    expect(shellDeadlineNotice(7_200_000)).toContain("after 2h in the background");
  });
});
