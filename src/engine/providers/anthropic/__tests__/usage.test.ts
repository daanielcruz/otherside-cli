import { beforeAll, describe, expect, it } from "bun:test";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import {
  clearRoutingUsage,
  clearUsageLimits,
  getCurrentLimits,
  getRawUtilization,
  getRoutingUsage,
  getRoutingUsageSnapshot,
  warningForProvider,
} from "@/engine/session/usage/limits.ts";
import { providerRouteability } from "@/engine/session/usage/provider-routeability.ts";
import { applyAnthropicUsageLimits, parseAnthropicUsage } from "../usage.ts";

beforeAll(() => registerAllProviders());

const RESET_SESSION = "2026-07-03T01:29:59Z";
const RESET_WEEK = "2026-07-07T21:59:59Z";

function liveShape(): Record<string, unknown> {
  return {
    five_hour: null,
    seven_day: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    extra_usage: { is_enabled: false },
    limits: [
      { kind: "session", group: "session", percent: 28, resets_at: RESET_SESSION, scope: null },
      { kind: "weekly_all", group: "weekly", percent: 71, resets_at: RESET_WEEK, scope: null },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 100,
        severity: "critical",
        resets_at: RESET_WEEK,
        scope: { model: { id: null, display_name: "Fable" }, surface: null },
        is_active: true,
      },
    ],
  };
}

describe("parseAnthropicUsage (limits[] shape)", () => {
  it("maps session/weekly_all/weekly_scoped-Fable from limits[]", () => {
    const usage = parseAnthropicUsage(liveShape());
    expect(usage.fiveHour).toEqual({ utilization: 28, resetsAt: RESET_SESSION });
    expect(usage.sevenDay).toEqual({ utilization: 71, resetsAt: RESET_WEEK });
    expect(usage.sevenDayFable).toEqual({ utilization: 100, resetsAt: RESET_WEEK });
  });

  it("yields all-undefined windows when limits[] is absent", () => {
    const usage = parseAnthropicUsage({ five_hour: null, seven_day: null });
    expect(usage.fiveHour).toBeUndefined();
    expect(usage.sevenDay).toBeUndefined();
    expect(usage.sevenDayFable).toBeUndefined();
  });

  it("ignores weekly_scoped entries for other models", () => {
    const payload = {
      limits: [
        {
          kind: "weekly_scoped",
          percent: 40,
          resets_at: RESET_WEEK,
          scope: { model: { display_name: "Opus" } },
        },
      ],
    };
    const usage = parseAnthropicUsage(payload);
    expect(usage.sevenDayFable).toBeUndefined();
  });
});

describe("applyAnthropicUsageLimits (Fable is per-model, not account-wide)", () => {
  it("keeps a maxed Fable week out of the account-wide limit state", () => {
    clearUsageLimits();
    applyAnthropicUsageLimits(parseAnthropicUsage(liveShape()));
    const limits = getCurrentLimits();
    // Worst NON-Fable window is weekly_all at 71% -> a warning, never rejected,
    // and the account-wide type must not read as the Fable bucket.
    expect(limits.rateLimitType).toBe("seven_day");
    expect(limits.status).not.toBe("rejected");
    // Fable stays in raw so the usage panel can still render its bar.
    expect(getRawUtilization().seven_day_fable?.utilization).toBe(1);
    clearUsageLimits();
  });

  it("stays allowed when only the Fable week is present and spent", () => {
    clearUsageLimits();
    applyAnthropicUsageLimits(
      parseAnthropicUsage({
        limits: [
          {
            kind: "weekly_scoped",
            percent: 100,
            resets_at: RESET_WEEK,
            scope: { model: { display_name: "Fable" } },
          },
        ],
      }),
    );
    const limits = getCurrentLimits();
    expect(limits.status).toBe("allowed");
    expect(limits.rateLimitType).toBeUndefined();
    clearUsageLimits();
  });
});

describe("applyAnthropicUsageLimits (provider+scope SoT: routeability)", () => {
  // Live-routing scopes are expiry-gated on their reset epoch, so these
  // provider-routeability-facing tests need a reset in the FUTURE (unlike
  // liveShape()'s fixed 2026 constants above, which only feed the pure
  // raw/limits parsing assertions).
  const futureIso = (): string => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  it("the Fable family scope blocks only claude-fable-5; a non-Fable model stays usable", () => {
    clearRoutingUsage();
    clearUsageLimits();
    applyAnthropicUsageLimits(
      parseAnthropicUsage({
        limits: [
          { kind: "session", percent: 20, resets_at: futureIso(), scope: null },
          { kind: "weekly_all", percent: 30, resets_at: futureIso(), scope: null },
          {
            kind: "weekly_scoped",
            percent: 100,
            resets_at: futureIso(),
            scope: { model: { id: null, display_name: "Fable" } },
          },
        ],
      }),
    );
    expect(providerRouteability("anthropic", undefined, "claude-fable-5").usable).toBe(false);
    expect(providerRouteability("anthropic", undefined, "claude-opus-4-8").usable).toBe(true);
    clearUsageLimits();
  });

  it("a global window (five_hour) applies to every model, Fable included", () => {
    clearRoutingUsage();
    clearUsageLimits();
    applyAnthropicUsageLimits(
      parseAnthropicUsage({
        limits: [{ kind: "session", percent: 100, resets_at: futureIso(), scope: null }],
      }),
    );
    expect(providerRouteability("anthropic", undefined, "claude-opus-4-8").usable).toBe(false);
    expect(providerRouteability("anthropic", undefined, "claude-fable-5").usable).toBe(false);
    clearUsageLimits();
  });

  it("extra usage utilization becomes a global overage scope", () => {
    clearRoutingUsage();
    clearUsageLimits();
    applyAnthropicUsageLimits({
      extraUsage: { isEnabled: true, monthlyLimit: 100, usedCredits: 100, utilization: 100 },
    });
    expect(getRoutingUsage("anthropic")?.balanceStatus).toBe("exhausted");
    expect(getRoutingUsageSnapshot().byProviderScope?.anthropic?.overage).toBeDefined();
    expect(warningForProvider("anthropic")?.message).toBe(
      "[Anthropic] 100% Extra usage · resets unknown",
    );
    expect(providerRouteability("anthropic", undefined, "claude-opus-4-8").usable).toBe(false);
    clearUsageLimits();
  });

  it("a fetched replacement atomically drops a stale Fable scope once Fable recovers", () => {
    clearRoutingUsage();
    clearUsageLimits();
    applyAnthropicUsageLimits(
      parseAnthropicUsage({
        limits: [
          {
            kind: "weekly_scoped",
            percent: 100,
            resets_at: futureIso(),
            scope: { model: { id: null, display_name: "Fable" } },
          },
        ],
      }),
    );
    expect(providerRouteability("anthropic", undefined, "claude-fable-5").usable).toBe(false);

    applyAnthropicUsageLimits(
      parseAnthropicUsage({
        limits: [{ kind: "session", percent: 10, resets_at: futureIso(), scope: null }],
      }),
    );
    expect(providerRouteability("anthropic", undefined, "claude-fable-5").usable).toBe(true);
    expect(providerRouteability("anthropic", undefined, "claude-opus-4-8").usable).toBe(true);
    clearUsageLimits();
  });

  it("an empty successful payload clears stale fetched scopes", () => {
    clearUsageLimits();
    applyAnthropicUsageLimits({
      fiveHour: { utilization: 100, resetsAt: futureIso() },
    });
    expect(providerRouteability("anthropic", undefined, "claude-opus-4-8").usable).toBe(false);

    applyAnthropicUsageLimits({});
    expect(getRoutingUsageSnapshot().byProviderScope?.anthropic).toBeUndefined();
    expect(providerRouteability("anthropic", undefined, "claude-opus-4-8").usable).toBe(true);
    clearUsageLimits();
  });
});
