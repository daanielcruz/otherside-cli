import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  completeTask,
  removeTask,
  resetEmitThrottleForTests,
  startShellTask,
  startTask,
} from "../background.ts";
import { startSharedOutputPoller, stopSharedOutputPoller } from "../output-poller.ts";

describe("background task timer lifecycle", () => {
  // A task left running in the shared store gates unrelated suites
  // (pressure reap skips while any agent task is running).
  const startedTasks: string[] = [];
  afterEach(() => {
    for (const id of startedTasks.splice(0)) removeTask(id);
  });

  test("unrefs the listener batching timer so it cannot hold the process open", () => {
    // Earlier suite files leave a live 250ms throttle window in module state;
    // inside it emit() takes the pending branch and never arms a new timer.
    resetEmitThrottleForTests();
    let scheduled: (() => void) | undefined;
    let unrefCalls = 0;
    const timer = {
      unref: () => {
        unrefCalls++;
      },
    } as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
    ) => {
      scheduled = callback;
      return timer;
    }) as unknown as typeof setTimeout);

    try {
      const task = startTask({ parentToolCallId: "call-emit-unref", agentName: "test" });
      startedTasks.push(task.id);
      expect(unrefCalls).toBe(1);
      scheduled?.();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("arms shared output polling only while a shell task is running", () => {
    const task = startShellTask({
      shellId: "shell-poller-lifecycle",
      command: "sleep 1",
      parentToolCallId: "call-poller-lifecycle",
    });
    startedTasks.push(task.id);
    let tick: (() => void) | undefined;
    let unrefCalls = 0;
    const timer = {
      unref: () => {
        unrefCalls++;
      },
    } as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((
      callback: () => void,
    ) => {
      tick = callback;
      return timer;
    }) as unknown as typeof setInterval);
    const clearIntervalSpy = spyOn(globalThis, "clearInterval").mockImplementation(() => {});

    try {
      startSharedOutputPoller(10);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(unrefCalls).toBe(1);
      completeTask(task.id, { content: "done", isError: false, exitCode: 0 });
      tick?.();
      expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    } finally {
      stopSharedOutputPoller();
      clearIntervalSpy.mockRestore();
      setIntervalSpy.mockRestore();
    }
  });
});
