import { describe, expect, test } from "bun:test";
import { createAbortableTimers } from "@/engine/background/workflows/runtime/sandbox/timers.ts";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createAbortableTimers", () => {
  test("a throwing callback is swallowed and reported instead of escaping to the host", async () => {
    const messages: string[] = [];
    const timers = createAbortableTimers(undefined, (message) => messages.push(message));
    timers.bindVMInvoke((callback) => callback());

    let uncaught: unknown;
    const onUncaughtException = (error: unknown): void => {
      uncaught = error;
    };
    process.once("uncaughtException", onUncaughtException);
    try {
      timers.setTimeout(() => {
        throw new Error("timer boom");
      }, 0);
      await wait(20);
    } finally {
      process.removeListener("uncaughtException", onUncaughtException);
    }

    expect(uncaught).toBeUndefined();
    expect(messages.some((message) => message.includes("timer boom"))).toBe(true);
  });

  test("a non-throwing callback is unaffected", async () => {
    let called = false;
    const timers = createAbortableTimers();
    timers.bindVMInvoke((callback) => callback());
    timers.setTimeout(() => {
      called = true;
    }, 0);
    await wait(20);
    expect(called).toBe(true);
  });
});
