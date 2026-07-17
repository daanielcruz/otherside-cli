import { beforeEach, describe, expect, it } from "bun:test";
import {
  beginYank,
  interruptKillChain,
  latestKill,
  nextYankPop,
  recordKill,
  resetKillRing,
} from "@/ui/input/kill-ring.ts";

beforeEach(() => {
  resetKillRing();
});

describe("kill ring", () => {
  it("returns the newest kill", () => {
    recordKill("first", "append");
    interruptKillChain();
    recordKill("second", "append");
    expect(latestKill()).toBe("second");
  });

  it("accumulates consecutive kills into one entry", () => {
    recordKill("world", "append");
    recordKill("hello ", "prepend");
    expect(latestKill()).toBe("hello world");
  });

  it("starts a fresh entry after an interrupt", () => {
    recordKill("one", "append");
    interruptKillChain();
    recordKill("two", "append");
    recordKill(" three", "append");
    expect(latestKill()).toBe("two three");
  });

  it("ignores empty kills", () => {
    recordKill("keep", "append");
    recordKill("", "append");
    expect(latestKill()).toBe("keep");
  });

  it("yank-pop cycles older entries with the span to replace", () => {
    recordKill("old", "append");
    interruptKillChain();
    recordKill("new", "append");
    beginYank(5, 3);
    const pop = nextYankPop();
    expect(pop).toEqual({ text: "old", start: 5, length: 3 });
  });

  it("yank-pop needs a preceding yank", () => {
    recordKill("one", "append");
    interruptKillChain();
    recordKill("two", "append");
    expect(nextYankPop()).toBeNull();
  });

  it("yank-pop needs more than one entry", () => {
    recordKill("only", "append");
    beginYank(0, 4);
    expect(nextYankPop()).toBeNull();
  });

  it("a kill after a yank breaks the pop chain", () => {
    recordKill("one", "append");
    interruptKillChain();
    recordKill("two", "append");
    beginYank(0, 3);
    recordKill("three", "append");
    expect(nextYankPop()).toBeNull();
  });
});
