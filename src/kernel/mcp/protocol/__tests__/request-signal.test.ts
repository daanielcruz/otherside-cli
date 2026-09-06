import { describe, expect, test } from "bun:test";
import { mcpRequestSignal, rejectPendingOnAbort } from "@/kernel/mcp/protocol/request-signal.ts";
import { AbortError } from "@/kernel/std/stream/abort.ts";

describe("mcpRequestSignal", () => {
  test("without a turn signal, abort is only the deadline", () => {
    const signal = mcpRequestSignal();
    expect(signal.aborted).toBe(false);
  });

  test("a pre-aborted turn signal aborts the combined signal immediately", () => {
    const turn = new AbortController();
    turn.abort();
    expect(mcpRequestSignal(turn.signal).aborted).toBe(true);
  });

  test("aborting the turn signal aborts the combined signal", () => {
    const turn = new AbortController();
    const combined = mcpRequestSignal(turn.signal);
    expect(combined.aborted).toBe(false);
    turn.abort();
    expect(combined.aborted).toBe(true);
  });
});

describe("rejectPendingOnAbort", () => {
  test("fires once when the turn aborts", async () => {
    const turn = new AbortController();
    let rejected: Error | null = null;
    const drop = rejectPendingOnAbort(turn.signal, (error) => {
      rejected = error;
    });
    turn.abort();
    await Promise.resolve();
    expect(rejected).toBeInstanceOf(AbortError);
    drop();
  });

  test("cleanup prevents a late abort from firing", async () => {
    const turn = new AbortController();
    let rejected: Error | null = null;
    const drop = rejectPendingOnAbort(turn.signal, (error) => {
      rejected = error;
    });
    drop();
    turn.abort();
    await Promise.resolve();
    expect(rejected).toBeNull();
  });
});
