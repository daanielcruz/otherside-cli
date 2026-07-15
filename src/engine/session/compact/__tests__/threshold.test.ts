import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  getAutoCompactThreshold,
  getModelAutoCompactThreshold,
} from "@/engine/session/compact/index.ts";

const BUFFER_ENV = "OTHERSIDE_AUTOCOMPACT_BUFFER_TOKENS";
const PCT_ENV = "OTHERSIDE_AUTOCOMPACT_PCT_OVERRIDE";

describe("auto-compact threshold", () => {
  const originalBuffer = process.env[BUFFER_ENV];
  const originalPct = process.env[PCT_ENV];

  beforeEach(() => {
    delete process.env[BUFFER_ENV];
    delete process.env[PCT_ENV];
  });

  afterEach(() => {
    if (originalBuffer === undefined) delete process.env[BUFFER_ENV];
    else process.env[BUFFER_ENV] = originalBuffer;
    if (originalPct === undefined) delete process.env[PCT_ENV];
    else process.env[PCT_ENV] = originalPct;
  });

  it("uses the model limit without a second generic gate", () => {
    expect(
      getModelAutoCompactThreshold({
        model: { contextWindow: 1_000_000, autoCompactTokenLimit: 950_000 },
        maxOutputTokens: 20_000,
        provider: "codex",
      }),
    ).toBe(950_000);
  });

  it("uses the 90% safeguard for an unmapped model", () => {
    expect(getAutoCompactThreshold(1_000_000, 20_000, "anthropic")).toBe(900_000);
    expect(
      getModelAutoCompactThreshold({
        model: { contextWindow: 1_000_000 },
        maxOutputTokens: 20_000,
        provider: "anthropic",
      }),
    ).toBe(900_000);
  });

  it("lets an explicit smaller window reduce a mapped limit", () => {
    expect(
      getModelAutoCompactThreshold({
        model: { contextWindow: 1_000_000, autoCompactTokenLimit: 950_000 },
        window: 200_000,
        maxOutputTokens: 20_000,
        provider: "codex",
      }),
    ).toBe(180_000);
  });

  it("lets an explicit percentage override reduce a mapped limit", () => {
    process.env[PCT_ENV] = "80";
    expect(
      getModelAutoCompactThreshold({
        model: { contextWindow: 1_000_000, autoCompactTokenLimit: 950_000 },
        maxOutputTokens: 20_000,
        provider: "codex",
      }),
    ).toBe(784_000);
  });
});
