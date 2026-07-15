import { describe, expect, it } from "bun:test";
import type { SubagentResult } from "@/engine/background/subagents/dispatcher.ts";
import {
  runForkWithRetries,
  type WorkflowForkRequest,
} from "@/engine/background/workflows/runtime/subagent/fork-retries.ts";

const request = {} as WorkflowForkRequest;

describe("workflow fork retries", () => {
  it("stops after the initial attempt plus five stall retries", async () => {
    let attempts = 0;
    const result: SubagentResult = { output: "stalled", isError: true, stalled: true };

    const outcome = await runForkWithRetries(
      async () => {
        attempts += 1;
        return result;
      },
      request,
      new AbortController().signal,
    );

    expect(attempts).toBe(6);
    expect(outcome.attempt).toBe(6);
    expect(outcome.lastAttemptReason).toBe("stalled");
    expect(outcome.result).toBe(result);
  });

  it("returns immediately when a stall retry makes progress", async () => {
    let attempts = 0;

    const outcome = await runForkWithRetries(
      async () => {
        attempts += 1;
        return attempts === 1
          ? { output: "stalled", isError: true, stalled: true }
          : { output: "done", isError: false };
      },
      request,
      new AbortController().signal,
    );

    expect(attempts).toBe(2);
    expect(outcome.attempt).toBe(2);
    expect(outcome.lastAttemptReason).toBe("stalled");
    expect(outcome.result.output).toBe("done");
  });
});
