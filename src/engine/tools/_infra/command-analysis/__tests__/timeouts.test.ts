import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getRuntimeKind, setRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import {
  backgroundDeadlineApplies,
  backgroundTimeoutMs,
  defaultBackgroundTimeoutMs,
  foregroundTimeoutMs,
  getMaxBackgroundTimeoutMs,
} from "../timeouts.ts";

const ENV_KEYS = ["BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS"] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("defaultBackgroundTimeoutMs", () => {
  test("defaults to thirty minutes", () => {
    expect(defaultBackgroundTimeoutMs()).toBe(1_800_000);
  });

  test("never falls below the foreground default", () => {
    process.env.BASH_DEFAULT_TIMEOUT_MS = "2400000";
    expect(defaultBackgroundTimeoutMs()).toBe(2_400_000);
  });
});

describe("getMaxBackgroundTimeoutMs", () => {
  test("defaults to two hours", () => {
    expect(getMaxBackgroundTimeoutMs()).toBe(7_200_000);
  });

  test("never falls below the foreground max", () => {
    process.env.BASH_MAX_TIMEOUT_MS = "9000000";
    expect(getMaxBackgroundTimeoutMs()).toBe(9_000_000);
  });

  test("stays within the longest timer delay", () => {
    process.env.BASH_MAX_TIMEOUT_MS = "9999999999";
    expect(getMaxBackgroundTimeoutMs()).toBe(2_147_483_647);
  });
});

describe("foregroundTimeoutMs", () => {
  test("uses the foreground default when no timeout is requested", () => {
    expect(foregroundTimeoutMs(null)).toBe(120_000);
  });

  test("caps a requested timeout at the foreground max", () => {
    expect(foregroundTimeoutMs(1_000_000)).toBe(600_000);
  });
});

describe("backgroundDeadlineApplies", () => {
  const runtimeBefore = getRuntimeKind();
  afterEach(() => {
    setRuntimeKind(runtimeBefore);
  });

  test("applies only when nobody is at the terminal", () => {
    setRuntimeKind("print");
    expect(backgroundDeadlineApplies()).toBe(true);
    setRuntimeKind("piped");
    expect(backgroundDeadlineApplies()).toBe(true);
    setRuntimeKind("interactive");
    expect(backgroundDeadlineApplies()).toBe(false);
  });

  test("an interactive session gives a background shell no time limit", () => {
    setRuntimeKind("interactive");
    expect(backgroundTimeoutMs(null)).toBeUndefined();
    expect(backgroundTimeoutMs(20_000)).toBeUndefined();
  });
});

describe("backgroundTimeoutMs", () => {
  const runtimeBefore = getRuntimeKind();
  beforeEach(() => {
    setRuntimeKind("print");
  });
  afterEach(() => {
    setRuntimeKind(runtimeBefore);
  });

  test("uses the background default when no timeout is requested", () => {
    expect(backgroundTimeoutMs(null)).toBe(1_800_000);
  });

  test("uses a requested timeout within the max", () => {
    expect(backgroundTimeoutMs(20_000)).toBe(20_000);
  });

  test("caps a requested timeout at the background max", () => {
    expect(backgroundTimeoutMs(10_000_000)).toBe(7_200_000);
  });
});
