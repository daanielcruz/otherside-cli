import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realConfig from "@/kernel/config/config.ts";

const originalConfig: Record<string | symbol, unknown> = {};
for (const key of Reflect.ownKeys(realConfig)) {
  originalConfig[key] = (realConfig as Record<string | symbol, unknown>)[key];
}

const realLoadConfigSync = realConfig.loadConfigSync;
let mockAutoMemoryEnabled: boolean | undefined;

const ENV_KEYS = ["OTHERSIDE_DISABLE_AUTO_MEMORY"] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  mockAutoMemoryEnabled = undefined;
  mock.module("@/kernel/config/config.ts", () => ({
    ...realConfig,
    loadConfigSync: () => ({
      ...realLoadConfigSync(),
      autoMemoryEnabled: mockAutoMemoryEnabled,
    }),
  }));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  mock.restore();
});

afterAll(() => {
  mock.module("@/kernel/config/config.ts", () => originalConfig);
});

describe("isAutoMemoryEnabled", () => {
  test("defaults to enabled with no env var and no setting", async () => {
    const { isAutoMemoryEnabled } = await import("@/kernel/storage/memory/session-toggle.ts");
    expect(isAutoMemoryEnabled()).toBe(true);
  });

  test.each([
    "1",
    "true",
    "yes",
    "on",
    " TRUE ",
    "On",
  ])("OTHERSIDE_DISABLE_AUTO_MEMORY=%s disables", async (value) => {
    process.env.OTHERSIDE_DISABLE_AUTO_MEMORY = value;
    const { isAutoMemoryEnabled } = await import("@/kernel/storage/memory/session-toggle.ts");
    expect(isAutoMemoryEnabled()).toBe(false);
  });

  test.each([
    "0",
    "false",
    "no",
    "off",
    "garbage",
    "",
  ])("OTHERSIDE_DISABLE_AUTO_MEMORY=%s does not disable", async (value) => {
    process.env.OTHERSIDE_DISABLE_AUTO_MEMORY = value;
    const { isAutoMemoryEnabled } = await import("@/kernel/storage/memory/session-toggle.ts");
    expect(isAutoMemoryEnabled()).toBe(true);
  });

  test("autoMemoryEnabled: false in settings disables when no env var is set", async () => {
    mockAutoMemoryEnabled = false;
    const { isAutoMemoryEnabled } = await import("@/kernel/storage/memory/session-toggle.ts");
    expect(isAutoMemoryEnabled()).toBe(false);
  });

  test("autoMemoryEnabled: true in settings stays enabled", async () => {
    mockAutoMemoryEnabled = true;
    const { isAutoMemoryEnabled } = await import("@/kernel/storage/memory/session-toggle.ts");
    expect(isAutoMemoryEnabled()).toBe(true);
  });

  test("session override wins over a truthy disable env var", async () => {
    process.env.OTHERSIDE_DISABLE_AUTO_MEMORY = "1";
    const { isAutoMemoryEnabled, setAutoMemorySessionEnabled, _resetAutoMemorySessionForTesting } =
      await import("@/kernel/storage/memory/session-toggle.ts");
    try {
      setAutoMemorySessionEnabled(true);
      expect(isAutoMemoryEnabled()).toBe(true);
    } finally {
      _resetAutoMemorySessionForTesting();
    }
  });

  test("session override wins over autoMemoryEnabled: false", async () => {
    mockAutoMemoryEnabled = false;
    const { isAutoMemoryEnabled, setAutoMemorySessionEnabled, _resetAutoMemorySessionForTesting } =
      await import("@/kernel/storage/memory/session-toggle.ts");
    try {
      setAutoMemorySessionEnabled(true);
      expect(isAutoMemoryEnabled()).toBe(true);
    } finally {
      _resetAutoMemorySessionForTesting();
    }
  });
});
