import { describe, expect, test } from "bun:test";
import { DESIGN_EVENT_POLL_INTERVAL_MS, startDurablePoll } from "./durable-poll.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("startDurablePoll", () => {
  test("polls immediately, repeats, and stops cleanly", async () => {
    let calls = 0;
    const stop = startDurablePoll(() => {
      calls += 1;
    }, 5);

    expect(calls).toBe(1);
    await sleep(18);
    // Windows timers may coalesce 5ms intervals to its ~15ms clock resolution.
    expect(calls).toBeGreaterThanOrEqual(2);
    stop();
    const stoppedAt = calls;
    await sleep(15);
    expect(calls).toBe(stoppedAt);
  });

  test("uses a five-second recovery interval", () => {
    expect(DESIGN_EVENT_POLL_INTERVAL_MS).toBe(5_000);
  });
});
