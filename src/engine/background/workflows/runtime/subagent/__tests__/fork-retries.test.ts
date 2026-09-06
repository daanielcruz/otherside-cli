import { afterEach, describe, expect, it } from "bun:test";
import type { SubagentResult } from "@/engine/background/subagents/dispatcher.ts";
import {
  runForkWithRetries,
  setWorkflowBackoffSleepForTests,
  type WorkflowForkRequest,
} from "@/engine/background/workflows/runtime/subagent/fork-retries.ts";

const request = {} as WorkflowForkRequest;

afterEach(() => {
  setWorkflowBackoffSleepForTests(null);
});

describe("workflow fork retries", () => {
  it("retries a throttled result once after the throttle backoff", async () => {
    const signal = new AbortController().signal;
    const sleeps: Array<{ ms: number; signal: AbortSignal }> = [];
    let attempts = 0;
    setWorkflowBackoffSleepForTests(async (ms, receivedSignal) => {
      sleeps.push({ ms, signal: receivedSignal });
    });

    const outcome = await runForkWithRetries(
      async (): Promise<SubagentResult> => {
        attempts += 1;
        return attempts === 1
          ? { output: "thin response", isError: false, outputTokens: 0, durationMs: 90_001 }
          : { output: "done", isError: false };
      },
      request,
      signal,
    );

    expect(attempts).toBe(2);
    expect(sleeps).toEqual([{ ms: 45_000, signal }]);
    expect(outcome).toEqual({
      result: { output: "done", isError: false },
      attempt: 2,
      lastAttemptReason: "throttled",
    });
  });

  it("returns a terminal provider error without retrying", async () => {
    let attempts = 0;
    const result: SubagentResult = {
      output: "content stream idle 600000ms — aborting (live connection, no model output)",
      isError: true,
    };

    const outcome = await runForkWithRetries(
      async () => {
        attempts += 1;
        return result;
      },
      request,
      new AbortController().signal,
    );

    expect(attempts).toBe(1);
    expect(outcome).toEqual({ result, attempt: 1 });
  });
});
