import { describe, expect, test } from "bun:test";
import { createConcurrencyWindow } from "@/engine/queue/runtime/turn/tool-dispatch.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushTasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("createConcurrencyWindow", () => {
  test("drains queued calls one-in-one-out without exceeding the limit", async () => {
    const run = createConcurrencyWindow(2);
    const gates = Array.from({ length: 5 }, () => deferred<number>());
    const started: number[] = [];
    let active = 0;
    let peak = 0;

    const results = gates.map((gate, index) =>
      run(async () => {
        started.push(index);
        active += 1;
        peak = Math.max(peak, active);
        const result = await gate.promise;
        active -= 1;
        return result;
      }),
    );

    await flushTasks();
    expect(started).toEqual([0, 1]);
    expect(peak).toBe(2);

    gates[1]?.resolve(1);
    await flushTasks();
    expect(started).toEqual([0, 1, 2]);
    expect(active).toBe(2);

    gates[0]?.resolve(0);
    await flushTasks();
    expect(started).toEqual([0, 1, 2, 3]);
    expect(active).toBe(2);

    gates[2]?.resolve(2);
    await flushTasks();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(active).toBe(2);

    gates[3]?.resolve(3);
    gates[4]?.resolve(4);
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  test("releases a detached background call before its task completes", async () => {
    const run = createConcurrencyWindow(1);
    const firstResult = deferred<string>();
    const firstDetached = deferred<void>();
    const secondResult = deferred<string>();
    const started: string[] = [];

    const first = run(async () => {
      started.push("first");
      return firstResult.promise;
    }, firstDetached.promise);
    const second = run(async () => {
      started.push("second");
      return secondResult.promise;
    });

    await flushTasks();
    expect(started).toEqual(["first"]);

    firstDetached.resolve();
    await flushTasks();
    expect(started).toEqual(["first", "second"]);

    secondResult.resolve("second-result");
    firstResult.resolve("first-result");
    expect(await Promise.all([first, second])).toEqual(["first-result", "second-result"]);
  });
});
