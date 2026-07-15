import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getMaxToolUseConcurrency } from "@/kernel/config/tool-use-concurrency.ts";

const ENV_KEYS = ["OTHERSIDE_MAX_TOOL_USE_CONCURRENCY"] as const;

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

describe("getMaxToolUseConcurrency", () => {
  test("defaults to 10", () => {
    expect(getMaxToolUseConcurrency()).toBe(10);
  });

  test("uses the primary override", () => {
    process.env.OTHERSIDE_MAX_TOOL_USE_CONCURRENCY = "4";
    expect(getMaxToolUseConcurrency()).toBe(4);
  });

  test("clamps values below one", () => {
    process.env.OTHERSIDE_MAX_TOOL_USE_CONCURRENCY = "0";
    expect(getMaxToolUseConcurrency()).toBe(1);

    process.env.OTHERSIDE_MAX_TOOL_USE_CONCURRENCY = "-3";
    expect(getMaxToolUseConcurrency()).toBe(1);
  });
});
