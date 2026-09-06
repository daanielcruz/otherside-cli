import { afterEach, describe, expect, it } from "bun:test";
import { StreamSilenceError } from "@/kernel/std/stream/idle-timeout.ts";
import { createCodexStreamDeadline, throwIfCodexDeadlineTimedOut } from "../deadline.ts";

const ENV_KEY = "OTHERSIDE_STREAM_IDLE_TIMEOUT_MS";

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Codex stream deadline", () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("aborts stalled streams with a retryable idle timeout", async () => {
    process.env[ENV_KEY] = "5";
    const deadline = createCodexStreamDeadline();
    try {
      await wait(20);
      expect(deadline.timedOut()).toBe(true);
      expect(deadline.signal.aborted).toBe(true);
      expect(() => throwIfCodexDeadlineTimedOut(deadline)).toThrow(StreamSilenceError);
    } finally {
      deadline.dispose();
    }
  });

  it("resets the timeout when progress arrives", async () => {
    process.env[ENV_KEY] = "30";
    const deadline = createCodexStreamDeadline();
    try {
      await wait(10);
      deadline.arm();
      await wait(10);
      expect(deadline.timedOut()).toBe(false);
      expect(deadline.signal.aborted).toBe(false);
    } finally {
      deadline.dispose();
    }
  });
});
