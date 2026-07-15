import { beforeEach, describe, expect, test } from "bun:test";
import {
  _resetWireLatchesForTests,
  getAfkLatched,
  getFastModeLatched,
  latchAfkIf,
  latchFastModeIf,
} from "@/engine/providers/anthropic/_infra/wire-latches.ts";

describe("wire-latches", () => {
  beforeEach(() => {
    _resetWireLatchesForTests();
  });

  test("fastMode latch starts false", () => {
    expect(getFastModeLatched()).toBe(false);
  });

  test("latchFastModeIf(true) flips on first activation", () => {
    expect(latchFastModeIf(true)).toBe(true);
    expect(getFastModeLatched()).toBe(true);
  });

  test("latchFastModeIf(false) does NOT flip latch off (sticky)", () => {
    latchFastModeIf(true);
    expect(latchFastModeIf(false)).toBe(true);
    expect(getFastModeLatched()).toBe(true);
  });

  test("latchFastModeIf(false) before any activation keeps latch off", () => {
    expect(latchFastModeIf(false)).toBe(false);
    expect(getFastModeLatched()).toBe(false);
  });

  test("afk latch independent of fastMode latch", () => {
    latchFastModeIf(true);
    expect(getAfkLatched()).toBe(false);
    latchAfkIf(true);
    expect(getAfkLatched()).toBe(true);
    expect(getFastModeLatched()).toBe(true);
  });

  test("_resetWireLatchesForTests clears both", () => {
    latchFastModeIf(true);
    latchAfkIf(true);
    _resetWireLatchesForTests();
    expect(getFastModeLatched()).toBe(false);
    expect(getAfkLatched()).toBe(false);
  });
});
