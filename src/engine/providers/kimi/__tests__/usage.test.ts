import { afterEach, describe, expect, it } from "bun:test";
import { applyKimiQuotaWarning, parseKimiUsagePayload } from "@/engine/providers/kimi/usage.ts";
import {
  clearRoutingUsage,
  clearUsageLimits,
  getRoutingUsage,
  stopUsageSweepTimerForTests,
} from "@/engine/session/usage/limits.ts";

const KIMI_USAGE_PAYLOAD = {
  usage: {
    limit: 1_000,
    used: 250,
    resetAt: "2026-07-20T12:00:00Z",
  },
  limits: [
    {
      scope: "Rolling prompts",
      detail: {
        limit: "200",
        remaining: "50",
        resetAt: "2026-07-18T15:00:00Z",
      },
      window: { duration: 300, timeUnit: "MINUTE" },
    },
  ],
  boosterWallet: {
    id: "wallet_placeholder",
    balance: {
      type: "BOOSTER",
      amount: "20000000000",
      amountLeft: "10000000000",
      unit: "UNIT_CURRENCY",
    },
    monthlyChargeLimitEnabled: true,
    monthlyChargeLimit: { currency: "USD", priceInCents: "20000" },
    monthlyUsed: { currency: "USD", priceInCents: "5000" },
  },
} as const;

afterEach(() => {
  clearRoutingUsage("kimi");
  clearUsageLimits();
  stopUsageSweepTimerForTests();
});

describe("parseKimiUsagePayload", () => {
  it("parses the complete usage and booster-wallet wire shape", () => {
    expect(parseKimiUsagePayload(KIMI_USAGE_PAYLOAD)).toEqual({
      summary: {
        label: "Weekly limit",
        used: 250,
        limit: 1_000,
        resetsAt: "2026-07-20T12:00:00Z",
      },
      limits: [
        {
          label: "Rolling prompts",
          used: 150,
          limit: 200,
          resetsAt: "2026-07-18T15:00:00Z",
        },
      ],
      extraUsage: {
        balanceCents: 10_000,
        totalCents: 20_000,
        monthlyChargeLimitEnabled: true,
        monthlyChargeLimitCents: 20_000,
        monthlyUsedCents: 5_000,
        currency: "USD",
      },
    });
  });

  it("parses explicit quota exhaustion and relative reset time", () => {
    const usage = parseKimiUsagePayload({
      usage: { limit: 1_000, remaining: 0, reset_in: 3_600 },
    });

    expect(usage).toEqual({
      summary: {
        label: "Weekly limit",
        used: 1_000,
        limit: 1_000,
        resetInSeconds: 3_600,
      },
      limits: [],
      extraUsage: null,
    });
    applyKimiQuotaWarning(usage);
    expect(getRoutingUsage("kimi")?.balanceStatus).toBe("exhausted");
  });

  it("returns null for missing or malformed usage fields", () => {
    expect(parseKimiUsagePayload(null)).toBeNull();
    expect(parseKimiUsagePayload({})).toBeNull();
    expect(parseKimiUsagePayload({ usage: { limit: "not-a-number" } })).toBeNull();
    expect(parseKimiUsagePayload({ limits: [null, "invalid", { detail: {} }] })).toBeNull();
    expect(
      parseKimiUsagePayload({
        boosterWallet: { balance: { type: "BOOSTER", amount: "not-a-number" } },
      }),
    ).toBeNull();
  });

  it("does not turn booster-wallet money into a routing quota", () => {
    const usage = parseKimiUsagePayload({
      boosterWallet: {
        balance: { type: "BOOSTER", amount: "20000000000", amountLeft: "0" },
      },
    });
    expect(usage).not.toBeNull();

    applyKimiQuotaWarning(usage);
    expect(getRoutingUsage("kimi")).toBeNull();
  });
});
