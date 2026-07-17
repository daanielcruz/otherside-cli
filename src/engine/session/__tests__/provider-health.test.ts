import { afterEach, describe, expect, it } from "bun:test";
import {
  clearProviderCooldowns,
  DEFAULT_PROVIDER_COOLDOWN_MS,
  getProviderCooldown,
  isProviderHealthy,
  markProviderCooldown,
} from "../usage/provider-health.ts";

afterEach(() => {
  clearProviderCooldowns();
});

describe("markProviderCooldown / isProviderHealthy", () => {
  it("blocks a provider until the reset timestamp (epoch ms)", () => {
    const until = Date.now() + 60_000;
    markProviderCooldown("glm", until, "rate_limited");
    expect(isProviderHealthy("glm")).toBe(false);
    const record = getProviderCooldown("glm");
    expect(record?.reason).toBe("rate_limited");
    expect(record?.untilEpochMs).toBe(until);
  });

  it("normalizes epoch-second resets to epoch ms", () => {
    const untilSeconds = Math.floor(Date.now() / 1000) + 120;
    markProviderCooldown("codex", untilSeconds);
    const record = getProviderCooldown("codex");
    expect(record?.untilEpochMs).toBe(untilSeconds * 1000);
    expect(record?.reason).toBe("rate_limited");
    expect(isProviderHealthy("codex")).toBe(false);
  });

  it("uses a default cooldown window when reset is unknown", () => {
    const before = Date.now();
    markProviderCooldown("deepseek", null);
    const record = getProviderCooldown("deepseek");
    expect(record?.untilEpochMs).toBeGreaterThanOrEqual(before + DEFAULT_PROVIDER_COOLDOWN_MS - 50);
    expect(record?.reason).toBe("rate_limited");
  });

  it("clears an expired cooldown and reports healthy again", () => {
    markProviderCooldown("kimi", Date.now() - 1_000);
    expect(isProviderHealthy("kimi")).toBe(true);
    expect(getProviderCooldown("kimi")).toBeNull();
  });

  it("treats untouched providers as healthy", () => {
    expect(isProviderHealthy("minimax")).toBe(true);
    expect(getProviderCooldown("minimax")).toBeNull();
  });
});
