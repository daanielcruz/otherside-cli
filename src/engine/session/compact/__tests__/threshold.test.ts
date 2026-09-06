import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  AUTO_COMPACT_TOKEN_HEADROOM,
  autoCompactTrigger,
  BLOCKING_COMPACT_TOKEN_HEADROOM,
  COMPACT_SUMMARY_TOKEN_RESERVE,
  COMPACT_WINDOW_MAXIMUM,
  COMPACT_WINDOW_MINIMUM,
  configuredCompactWindow,
  modelAutoCompactTrigger,
  modelBlockingCeiling,
  readCompactWindowValue,
} from "@/engine/session/compact/index.ts";

const BUFFER_ENV = "OTHERSIDE_AUTOCOMPACT_BUFFER_TOKENS";
const PCT_ENV = "OTHERSIDE_AUTOCOMPACT_PCT_OVERRIDE";
const WINDOW_ENV = "OTHERSIDE_AUTO_COMPACT_WINDOW";
const ENV_NAMES = [BUFFER_ENV, PCT_ENV, WINDOW_ENV] as const;

describe("compact numeric policy", () => {
  const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

  beforeEach(() => {
    for (const name of ENV_NAMES) delete process.env[name];
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      const value = originalEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("parses compact window shorthand at the accepted boundaries", () => {
    expect(readCompactWindowValue(" auto ")).toBe("auto");
    expect(readCompactWindowValue("100k")).toBe(COMPACT_WINDOW_MINIMUM);
    expect(readCompactWindowValue("0.1m")).toBe(COMPACT_WINDOW_MINIMUM);
    expect(readCompactWindowValue("100")).toBe(COMPACT_WINDOW_MINIMUM);
    expect(readCompactWindowValue("1000")).toBe(COMPACT_WINDOW_MAXIMUM);
    expect(readCompactWindowValue("1m")).toBe(COMPACT_WINDOW_MAXIMUM);
    expect(readCompactWindowValue("100.4k")).toBe(100_400);
  });

  it("rejects shorthand outside policy range and preserves bare-number scaling", () => {
    expect(readCompactWindowValue("99")).toBeUndefined();
    expect(readCompactWindowValue("1001")).toBeUndefined();
    expect(readCompactWindowValue("99k")).toBeUndefined();
    expect(readCompactWindowValue("1.1m")).toBeUndefined();
    expect(readCompactWindowValue("-100k")).toBeUndefined();
    expect(readCompactWindowValue("garbage")).toBeUndefined();
    expect(readCompactWindowValue("1e309m")).toBeUndefined();
  });

  it("prefers a valid product env window, then settings, then model capacity", () => {
    process.env[WINDOW_ENV] = "200k";
    expect(configuredCompactWindow(1_000_000, 300_000)).toEqual({
      window: 200_000,
      configured: 200_000,
      source: "env",
    });
    process.env[WINDOW_ENV] = "auto";
    expect(configuredCompactWindow(1_000_000, 300_000)).toEqual({
      window: 300_000,
      configured: 300_000,
      source: "settings",
    });
    delete process.env[WINDOW_ENV];
    expect(configuredCompactWindow(950_000)).toEqual({
      window: 950_000,
      configured: 950_000,
      source: "auto",
    });
  });

  it("reserves capped summary output and automatic headroom", () => {
    expect(COMPACT_SUMMARY_TOKEN_RESERVE).toBe(20_000);
    expect(AUTO_COMPACT_TOKEN_HEADROOM).toBe(13_000);
    expect(autoCompactTrigger(1_000_000, 20_000, "anthropic")).toBe(967_000);
    expect(autoCompactTrigger(1_000_000, 19_999)).toBe(967_001);
    expect(autoCompactTrigger(1_000_000, 20_001)).toBe(967_000);
  });

  it("uses the model limit without a second generic gate", () => {
    expect(
      modelAutoCompactTrigger({
        model: { contextWindow: 1_000_000, autoCompactTokenLimit: 950_000 },
        maxOutputTokens: 20_000,
        provider: "codex",
      }),
    ).toBe(950_000);
  });

  it("uses the policy trigger when a model has no stored limit", () => {
    expect(
      modelAutoCompactTrigger({
        model: { contextWindow: 1_000_000 },
        maxOutputTokens: 20_000,
        provider: "anthropic",
      }),
    ).toBe(967_000);
  });

  it("lets an explicit smaller window reduce a mapped limit", () => {
    expect(
      modelAutoCompactTrigger({
        model: { contextWindow: 1_000_000, autoCompactTokenLimit: 950_000 },
        window: 200_000,
        maxOutputTokens: 20_000,
        provider: "codex",
      }),
    ).toBe(167_000);
  });

  it("applies percentage override with the lower policy trigger", () => {
    process.env[PCT_ENV] = "80";
    expect(
      modelAutoCompactTrigger({
        model: { contextWindow: 1_000_000, autoCompactTokenLimit: 950_000 },
        maxOutputTokens: 20_000,
        provider: "codex",
      }),
    ).toBe(784_000);
    process.env[PCT_ENV] = "100";
    expect(autoCompactTrigger(1_000_000, 20_000)).toBe(967_000);
    process.env[PCT_ENV] = "0";
    expect(autoCompactTrigger(1_000_000, 20_000)).toBe(967_000);
    process.env[PCT_ENV] = "101";
    expect(autoCompactTrigger(1_000_000, 20_000)).toBe(967_000);
  });

  it("uses the smaller blocking headroom at its boundaries", () => {
    expect(BLOCKING_COMPACT_TOKEN_HEADROOM).toBe(3_000);
    expect(
      modelBlockingCeiling({
        model: { contextWindow: 1_000_000 },
        maxOutputTokens: 20_000,
      }),
    ).toBe(977_000);
    expect(
      modelBlockingCeiling({
        model: { contextWindow: 1_000_000 },
        window: 200_000,
        maxOutputTokens: 20_000,
      }),
    ).toBe(177_000);
  });
});
