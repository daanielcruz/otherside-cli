import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyXaiQuotaWarning,
  fetchXaiUsage,
  parseXaiBillingPayload,
} from "@/engine/providers/xai/usage.ts";
import {
  clearRoutingUsage,
  getRoutingUsage,
  stopUsageSweepTimerForTests,
} from "@/engine/session/usage/limits.ts";
import { saveFor } from "@/kernel/storage/credentials.ts";

const originalFetch = global.fetch;
const originalConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
let configDir: string | null = null;

afterEach(() => {
  global.fetch = originalFetch;
  if (originalConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = originalConfigDir;
  if (configDir !== null) rmSync(configDir, { recursive: true, force: true });
  configDir = null;
  clearRoutingUsage("xai");
  stopUsageSweepTimerForTests();
});

describe("fetchXaiUsage", () => {
  test("makes one credits request with the required billing headers", async () => {
    configDir = mkdtempSync(join(tmpdir(), "xai-usage-test-"));
    process.env.OTHERSIDE_CONFIG_DIR = configDir;
    await saveFor("xai", {
      accessToken: "xai-access",
      refreshToken: "xai-refresh",
      expiresAt: Date.now() + 10 * 60_000,
      accountId: "xai-user",
    });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), ...(init !== undefined ? { init } : {}) });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            config: {
              creditUsagePercent: 62,
              currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
            },
          }),
        ),
      );
    }) as unknown as typeof fetch;

    await expect(fetchXaiUsage()).resolves.not.toBeNull();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
    expect(requests[0]?.init?.headers).toMatchObject({
      Authorization: "Bearer xai-access",
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-userid": "xai-user",
      "x-grok-client-version": "0.2.102",
      "x-grok-client-mode": "headless",
    });
  });

  test("refreshes once and retries an unauthorized billing request", async () => {
    configDir = mkdtempSync(join(tmpdir(), "xai-usage-test-"));
    process.env.OTHERSIDE_CONFIG_DIR = configDir;
    await saveFor("xai", {
      accessToken: "stale_access",
      refreshToken: "stale_refresh",
      expiresAt: Date.now() + 10 * 60_000,
      accountId: "xai-user",
    });

    let billingCalls = 0;
    let refreshCalls = 0;
    let lastAuthorization = "";
    global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/oauth2/token")) {
        refreshCalls++;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "fresh_access",
              refresh_token: "fresh_refresh",
              expires_in: 3600,
            }),
          ),
        );
      }
      billingCalls++;
      lastAuthorization = (init?.headers as Record<string, string>).Authorization ?? "";
      if (billingCalls === 1) return Promise.resolve(new Response("expired", { status: 401 }));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            config: {
              creditUsagePercent: 62,
              currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
            },
          }),
        ),
      );
    }) as unknown as typeof fetch;

    await expect(fetchXaiUsage()).resolves.not.toBeNull();

    expect(billingCalls).toBe(2);
    expect(refreshCalls).toBe(1);
    expect(lastAuthorization).toBe("Bearer fresh_access");
  });
});

describe("applyXaiQuotaWarning", () => {
  test("routes the standard credits-config percentage through the normal quota gate", () => {
    applyXaiQuotaWarning({
      level: null,
      windows: [{ label: "Weekly limit", limit: { utilization: 100, resetsAt: null } }],
    });
    expect(getRoutingUsage("xai")?.balanceStatus).toBe("exhausted");
  });
});

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

  test("ignores on-demand and legacy credit amounts outside the standard quota", () => {
    const data = parseXaiBillingPayload({
      config: {
        creditUsagePercent: 10,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-07-15T00:00:00Z" },
        onDemandCap: { val: 100 },
        onDemandUsed: { val: 25 },
        prepaidBalance: { val: 500 },
        monthlyLimit: { val: 15000 },
        used: { val: 1013 },
      },
    });
    expect(data?.windows).toHaveLength(1);
    expect(data?.windows[0]?.label).toBe("Weekly limit");
  });

  test("does not derive standard quota from deprecated monthly credit amounts", () => {
    expect(
      parseXaiBillingPayload({
        config: {
          monthlyLimit: { val: 15000 },
          used: { val: 1013 },
          billingPeriodEnd: "2026-08-01T00:00:00+00:00",
        },
      }),
    ).toBeNull();
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

  test("parses explicit exhaustion and clamps over-limit utilization", () => {
    const exhausted = parseXaiBillingPayload({
      config: { creditUsagePercent: 100, currentPeriod: { type: "USAGE_PERIOD_TYPE_DAILY" } },
    });
    expect(exhausted?.windows[0]).toMatchObject({
      label: "Daily limit",
      limit: { utilization: 100 },
      detail: "100% used",
    });

    const overLimit = parseXaiBillingPayload({
      config: { creditUsagePercent: 140, currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" } },
    });
    expect(overLimit?.windows[0]?.limit.utilization).toBe(100);
    expect(overLimit?.windows[0]?.label).toBe("Monthly limit");
  });

  test("fails closed when the utilization field is malformed", () => {
    expect(parseXaiBillingPayload({ config: { creditUsagePercent: "100" } })).toBeNull();
    expect(parseXaiBillingPayload({ config: { creditUsagePercent: Number.NaN } })).toBeNull();
    expect(parseXaiBillingPayload({ config: [] })).toBeNull();
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
