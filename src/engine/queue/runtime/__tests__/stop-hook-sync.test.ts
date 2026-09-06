import { describe, expect, test } from "bun:test";
import { syncStopHookVerdict } from "@/engine/queue/runtime/stop-hook-sync.ts";

describe("syncStopHookVerdict", () => {
  test("a Stop hook blocks the turn the same way an explicit block decision does", () => {
    const entry = { matcher: "*", command: "stop-check" };

    expect(
      syncStopHookVerdict(entry, { kind: "prompt_blocked", reason: "not finished yet" }),
    ).toEqual({ kind: "block", feedback: "not finished yet" });
    expect(
      syncStopHookVerdict(entry, {
        kind: "ok",
        stdout: JSON.stringify({ continue: false }),
        stderr: "",
        exit: 0,
      }),
    ).toEqual({ kind: "block", feedback: "Stopped by hook" });
  });
});
