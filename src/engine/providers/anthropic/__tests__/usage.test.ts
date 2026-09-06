import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { type AnthropicTokens, saveFor } from "@/kernel/storage/credentials.ts";
import { applyAnthropicUsageLimits, fetchAnthropicUsage, parseAnthropicUsage } from "../usage.ts";

beforeAll(() => registerAllProviders());

const RESET_SESSION = "2026-07-03T01:29:59Z";
const RESET_WEEK = "2026-07-07T21:59:59Z";
const originalFetch = global.fetch;
const originalConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
let credentialDir: string | null = null;

function testTokens(scopes?: string[]): AnthropicTokens {
  return {
    accessToken: "anthropic-test-token",
    refreshToken: "anthropic-test-refresh",
    expiresAt: Date.now() + 10 * 60_000,
    ...(scopes !== undefined ? { scopes } : {}),
  };
}

afterEach(() => {
  global.fetch = originalFetch;
  if (originalConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = originalConfigDir;
  if (credentialDir !== null) rmSync(credentialDir, { recursive: true, force: true });
  credentialDir = null;
});

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

describe("fetchAnthropicUsage profile scope gate", () => {
  it.each([
    [undefined],
    [[]],
    [["user:profile"]],
    [["user:inference"]],
  ] as const)("skips the endpoint without both inference and profile scopes for %p", async (scopes) => {
    credentialDir = mkdtempSync(join(tmpdir(), "anthropic-usage-scope-"));
    process.env.OTHERSIDE_CONFIG_DIR = credentialDir;
    await saveFor("anthropic", testTokens(scopes === undefined ? undefined : [...scopes]));
    let fetchCount = 0;
    global.fetch = mock(() => {
      fetchCount += 1;
      return Promise.resolve(new Response(JSON.stringify({ limits: [] })));
    }) as unknown as typeof fetch;

    await expect(fetchAnthropicUsage()).resolves.toBeNull();
    expect(fetchCount).toBe(0);
  });

  it("fetches when user:profile is present", async () => {
    credentialDir = mkdtempSync(join(tmpdir(), "anthropic-usage-scope-"));
    process.env.OTHERSIDE_CONFIG_DIR = credentialDir;
    await saveFor("anthropic", testTokens(["user:inference", "user:profile"]));
    let fetchCount = 0;
    global.fetch = mock(() => {
      fetchCount += 1;
      return Promise.resolve(new Response(JSON.stringify({ limits: [] })));
    }) as unknown as typeof fetch;

    await expect(fetchAnthropicUsage()).resolves.toEqual({ extraUsage: undefined });
    expect(fetchCount).toBe(1);
  });
});

describe("parseAnthropicUsage (current usage response)", () => {
  it("maps session/weekly_all/weekly_scoped-Fable from limits[]", () => {
    const usage = parseAnthropicUsage(liveShape());
    expect(usage.fiveHour).toEqual({ utilization: 28, resetsAt: RESET_SESSION });
    expect(usage.sevenDay).toEqual({ utilization: 71, resetsAt: RESET_WEEK });
    expect(usage.sevenDayFable).toEqual({ utilization: 100, resetsAt: RESET_WEEK });
    expect(usage.modelScoped).toEqual([
      { displayName: "Fable", utilization: 100, resetsAt: RESET_WEEK },
    ]);
  });

  it("preserves all named top-level windows", () => {
    const usage = parseAnthropicUsage({
      five_hour: { utilization: 10, resets_at: RESET_SESSION },
      seven_day: { utilization: 20, resets_at: RESET_WEEK },
      seven_day_oauth_apps: { utilization: 30, resets_at: RESET_WEEK },
      seven_day_opus: { utilization: 40, resets_at: RESET_WEEK },
      seven_day_sonnet: { utilization: 50, resets_at: RESET_WEEK },
      cinder_cove: { utilization: 60, resets_at: RESET_WEEK },
    });
    expect(usage).toMatchObject({
      fiveHour: { utilization: 10, resetsAt: RESET_SESSION },
      sevenDay: { utilization: 20, resetsAt: RESET_WEEK },
      sevenDayOauthApps: { utilization: 30, resetsAt: RESET_WEEK },
      sevenDayOpus: { utilization: 40, resetsAt: RESET_WEEK },
      sevenDaySonnet: { utilization: 50, resetsAt: RESET_WEEK },
      cinderCove: { utilization: 60, resetsAt: RESET_WEEK },
    });
  });

  it("retains explicit nulls for named windows", () => {
    const usage = parseAnthropicUsage({ five_hour: null, seven_day: null });
    expect(usage.fiveHour).toBeNull();
    expect(usage.sevenDay).toBeNull();
    expect(usage.sevenDayFable).toBeUndefined();
  });

  it("normalizes numeric resets_at values as epoch seconds", () => {
    const usage = parseAnthropicUsage({
      limits: [{ kind: "session", percent: 40, resets_at: 1_893_456_000, scope: null }],
    });
    expect(usage.fiveHour).toEqual({
      utilization: 40,
      resetsAt: new Date(1_893_456_000 * 1000).toISOString(),
    });
  });

  it("retains all model-scoped rows without changing unknown routing scopes", () => {
    const payload = {
      limits: [
        {
          kind: "weekly_scoped",
          percent: 40,
          resets_at: RESET_WEEK,
          scope: { model: { display_name: "Opus" } },
        },
        {
          kind: "weekly_scoped",
          percent: 65,
          resets_at: RESET_WEEK,
          scope: { model: { display_name: "Future Model" } },
        },
      ],
    };
    const usage = parseAnthropicUsage(payload);
    expect(usage.sevenDayFable).toBeUndefined();
    expect(usage.modelScoped).toEqual([
      { displayName: "Opus", utilization: 40, resetsAt: RESET_WEEK },
      { displayName: "Future Model", utilization: 65, resetsAt: RESET_WEEK },
    ]);
  });

  it("preserves extra-usage currency and disabled reason", () => {
    expect(
      parseAnthropicUsage({
        extra_usage: {
          is_enabled: false,
          monthly_limit: 200,
          used_credits: 25,
          utilization: 12.5,
          currency: "EUR",
          disabled_reason: "org_spend_cap_reached",
        },
      }).extraUsage,
    ).toEqual({
      isEnabled: false,
      monthlyLimit: 200,
      usedCredits: 25,
      utilization: 12.5,
      currency: "EUR",
      disabledReason: "org_spend_cap_reached",
    });
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

  it("a null fetch result preserves the last observed scopes", () => {
    clearUsageLimits();
    applyAnthropicUsageLimits({
      fiveHour: { utilization: 100, resetsAt: futureIso() },
    });
    expect(providerRouteability("anthropic", undefined, "claude-opus-4-8").usable).toBe(false);

    applyAnthropicUsageLimits(null);
    expect(getRoutingUsageSnapshot().byProviderScope?.anthropic).toBeDefined();
    expect(providerRouteability("anthropic", undefined, "claude-opus-4-8").usable).toBe(false);
    clearUsageLimits();
  });
});
