import { describe, expect, test } from "bun:test";
import { parseXaiBillingPayload } from "@/engine/providers/xai/usage.ts";

describe("parseXaiBillingPayload", () => {
  test("maps format=credits weekly utilization to the primary window", () => {
    const payload = {
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-07-08T19:43:21.614389+00:00",
          end: "2026-07-15T19:43:21.614389+00:00",
        },
        creditUsagePercent: 62.0,
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
        productUsage: [
          { product: "GrokBuild", usagePercent: 62.0 },
          { product: "Api" },
          { product: "GrokChat" },
        ],
        isUnifiedBillingUser: true,
        prepaidBalance: { val: 0 },
        billingPeriodStart: "2026-07-08T19:43:21.614389+00:00",
        billingPeriodEnd: "2026-07-15T19:43:21.614389+00:00",
      },
    };
    const data = parseXaiBillingPayload(payload);
    expect(data).not.toBeNull();
    expect(data?.windows).toHaveLength(1);
    const window = data?.windows[0];
    expect(window?.label).toBe("Weekly limit");
    expect(window?.limit.utilization).toBe(62);
    expect(window?.limit.resetsAt).toBe(new Date("2026-07-15T19:43:21.614389+00:00").toISOString());
    expect(window?.detail).toBe("62% used");
  });

  test("adds on-demand window when a positive cap is present", () => {
    const data = parseXaiBillingPayload({
      config: {
        creditUsagePercent: 10,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-07-15T00:00:00Z" },
        onDemandCap: { val: 100 },
        onDemandUsed: { val: 25 },
      },
    });
    expect(data?.windows).toHaveLength(2);
    expect(data?.windows[1]?.label).toBe("On-demand credits");
    expect(data?.windows[1]?.limit.utilization).toBe(25);
    expect(data?.windows[1]?.detail).toBe("25 / 100 on-demand");
  });

  test("falls back to monthly used/limit when creditUsagePercent is absent", () => {
    const payload = {
      config: {
        monthlyLimit: { val: 15000 },
        used: { val: 1013 },
        onDemandCap: { val: 0 },
        billingPeriodStart: "2026-07-01T00:00:00+00:00",
        billingPeriodEnd: "2026-08-01T00:00:00+00:00",
        history: [],
      },
    };
    const data = parseXaiBillingPayload(payload);
    expect(data).not.toBeNull();
    expect(data?.windows).toHaveLength(1);
    const window = data?.windows[0];
    expect(window?.label).toBe("Monthly credits");
    expect(window?.limit.utilization).toBeCloseTo((1013 / 15000) * 100, 5);
    expect(window?.limit.resetsAt).toBe(new Date("2026-08-01T00:00:00+00:00").toISOString());
    expect(window?.detail).toBe("1,013 / 15,000 credits");
  });

  test("returns null when no usable windows are present", () => {
    expect(parseXaiBillingPayload({ config: { used: { val: 10 } } })).toBeNull();
    expect(
      parseXaiBillingPayload({ config: { monthlyLimit: { val: 0 }, used: { val: 10 } } }),
    ).toBeNull();
    expect(parseXaiBillingPayload({})).toBeNull();
    expect(parseXaiBillingPayload(null)).toBeNull();
  });

  test("format=credits period metadata without utilization yields null (needs monthly fallback)", () => {
    // Live SuperGrok shape observed 2026-07-14: 200 OK, period only, no percent.
    expect(
      parseXaiBillingPayload({
        config: {
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-07-14T01:01:32.584093+00:00",
            end: "2026-07-21T01:01:32.584093+00:00",
          },
          onDemandCap: { val: 0 },
          onDemandUsed: { val: 0 },
          isUnifiedBillingUser: true,
          prepaidBalance: { val: 0 },
          billingPeriodStart: "2026-07-14T01:01:32.584093+00:00",
          billingPeriodEnd: "2026-07-21T01:01:32.584093+00:00",
        },
      }),
    ).toBeNull();
  });

  test("clamps utilization to 100% when usage exceeds the limit", () => {
    const data = parseXaiBillingPayload({
      config: { creditUsagePercent: 140, currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" } },
    });
    expect(data?.windows[0]?.limit.utilization).toBe(100);
    expect(data?.windows[0]?.label).toBe("Monthly limit");
  });

  test("leaves resetsAt null on an unparseable billing period", () => {
    const data = parseXaiBillingPayload({
      config: {
        creditUsagePercent: 10,
        billingPeriodEnd: "not-a-date",
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "not-a-date" },
      },
    });
    expect(data?.windows[0]?.limit.resetsAt).toBeNull();
  });
});
