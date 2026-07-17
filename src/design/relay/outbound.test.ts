import { describe, expect, test } from "bun:test";
import { createRelayBatcher } from "./outbound.ts";

describe("design relay outbound batching", () => {
  test("preserves order while limiting each timed batch", () => {
    const originalSetTimeout = globalThis.setTimeout;
    const scheduled: Array<() => void> = [];
    globalThis.setTimeout = ((callback: unknown) => {
      if (typeof callback !== "function") throw new Error("expected batch timer callback");
      scheduled.push(callback as () => void);
      return {} as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    try {
      const batches: number[][] = [];
      const push = createRelayBatcher<number>((items) => batches.push(items), 3, 5);

      for (let value = 1; value <= 7; value += 1) push(value);

      expect(batches).toEqual([]);
      while (scheduled.length > 0) scheduled.shift()?.();
      expect(batches).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});
