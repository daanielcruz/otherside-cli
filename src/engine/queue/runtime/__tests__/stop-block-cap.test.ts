import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  stopBlockCapReached,
  stopBlockCapText,
} from "@/engine/queue/runtime/stop-hook-classifier.ts";

describe("the stop block cap", () => {
  let previousCap: string | undefined;

  beforeEach(() => {
    previousCap = process.env.OTHERSIDE_STOP_HOOK_BLOCK_CAP;
    delete process.env.OTHERSIDE_STOP_HOOK_BLOCK_CAP;
  });

  afterEach(() => {
    if (previousCap === undefined) delete process.env.OTHERSIDE_STOP_HOOK_BLOCK_CAP;
    else process.env.OTHERSIDE_STOP_HOOK_BLOCK_CAP = previousCap;
  });

  test("overrides the ninth consecutive block by default", () => {
    expect(stopBlockCapReached(8)).toBe(false);
    expect(stopBlockCapReached(9)).toBe(true);
  });

  test("follows a cap set in the environment", () => {
    process.env.OTHERSIDE_STOP_HOOK_BLOCK_CAP = "2";
    expect(stopBlockCapReached(2)).toBe(false);
    expect(stopBlockCapReached(3)).toBe(true);
  });

  test("never overrides when the cap is zero or less", () => {
    for (const cap of ["0", "-1"]) {
      process.env.OTHERSIDE_STOP_HOOK_BLOCK_CAP = cap;
      expect(stopBlockCapReached(1_000)).toBe(false);
    }
  });

  test("tells the reader the turn ended and how to raise the cap", () => {
    expect(stopBlockCapText(9)).toBe(
      "A hook blocked the turn from ending 9 consecutive times — overriding and ending turn. " +
        "For Stop/SubagentStop hooks, check stop_hook_active in the input and return success while it's true. " +
        "Set OTHERSIDE_STOP_HOOK_BLOCK_CAP to raise this limit.",
    );
  });
});
