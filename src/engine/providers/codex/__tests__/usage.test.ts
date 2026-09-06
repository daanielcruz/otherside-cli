import { afterEach, describe, expect, it } from "bun:test";
import {
  clearRoutingUsage,
  clearUsageLimits,
  getRoutingUsage,
  getRoutingUsageSnapshot,
} from "@/engine/session/usage/limits.ts";
import { providerRouteability } from "@/engine/session/usage/provider-routeability.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import { translateResponseCodex } from "../stream.ts";
import {
  applyCodexQuotaWarning,
  type CodexUsage,
  codexUsageToSseFrame,
  parseCodexUsageHeaders,
  parseCodexUsagePayload,
} from "../usage.ts";

async function* makeSseStream(usageFrame: Uint8Array, events: object[]): AsyncIterable<Uint8Array> {
  yield usageFrame;
  const enc = new TextEncoder();
  for (const event of events) {
    yield enc.encode(`data: ${JSON.stringify(event)}\n\n`);
  }
}

describe("codex usage parsing and frame injection seam", () => {
  it("parses headers, constructs SSE frame, and asserts usage_limits precedes message_start", async () => {
    const headers = new Headers({
      "x-codex-primary-used-percent": "42",
      "x-codex-primary-window-minutes": "60",
      "x-codex-primary-reset-at": "1720549200",
      "x-codex-secondary-used-percent": "84",
      "x-codex-secondary-window-minutes": "1440",
      "x-codex-secondary-reset-at": "1720635600",
      "x-codex-plan-type": "plus",
      "x-codex-rate-limit-reached-type": "workspace_member_credits_depleted",
    });

    const usage = parseCodexUsageHeaders(headers);
    expect(usage).not.toBeNull();
    if (!usage) return;

    expect(usage.primary?.utilization).toBe(42);
    expect(usage.primary?.windowMinutes).toBe(60);
    expect(usage.secondary?.utilization).toBe(84);
    expect(usage.secondary?.windowMinutes).toBe(1440);
    expect(usage.planType).toBe("plus");
    expect(usage.rateLimitReachedType).toBe("workspace_member_credits_depleted");

    const sseFrame = codexUsageToSseFrame(usage);
    const events = [
      { type: "response.created", response: { id: "r1" } },
      { type: "response.completed", response: { status: "completed" } },
    ];

    const out: ProviderEvent[] = [];
    for await (const event of translateResponseCodex(makeSseStream(sseFrame, events))) {
      out.push(event);
    }

    expect(out.length).toBeGreaterThanOrEqual(2);
    const event0 = out[0];
    const event1 = out[1];
    expect(event0).toBeDefined();
    expect(event1).toBeDefined();
    if (!event0 || !event1) return;

    expect(event0.kind).toBe("usage_limits");
    expect(event1.kind).toBe("message_start");

    const usageEvent = event0 as Extract<ProviderEvent, { kind: "usage_limits" }> & {
      usage: {
        primary?: { utilization: number | null; windowMinutes?: number | null };
        secondary?: { utilization: number | null; windowMinutes?: number | null };
        planType?: string | null;
        rateLimitReachedType?: string | null;
      };
    };
    expect(usageEvent.usage).toBeDefined();
    expect(usageEvent.usage?.primary?.utilization).toBe(42);
    expect(usageEvent.usage?.primary?.windowMinutes).toBe(60);
    expect(usageEvent.usage?.secondary?.utilization).toBe(84);
    expect(usageEvent.usage?.secondary?.windowMinutes).toBe(1440);
    expect(usageEvent.usage?.planType).toBe("plus");
    expect(usageEvent.usage?.rateLimitReachedType).toBe("workspace_member_credits_depleted");
  });

  it("parses payload percentages, ceiling-minute windows, credits, spend control, and additional limits", () => {
    const usage = parseCodexUsagePayload({
      plan_type: "pro",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 1,
          limit_window_seconds: 61,
          reset_after_seconds: 10,
          reset_at: 1_893_456_000,
        },
        secondary_window: {
          used_percent: 80,
          limit_window_seconds: 0,
          reset_after_seconds: 0,
          reset_at: 1_893_456_100,
        },
      },
      credits: { has_credits: true, unlimited: false, balance: "9.99" },
      spend_control: {
        reached: false,
        individual_limit: {
          limit: "25000",
          used: "8000",
          remaining_percent: 68,
          reset_at: 1_893_456_200,
        },
      },
      additional_rate_limits: [
        {
          limit_name: "gpt-5.3-codex-spark",
          metered_feature: "codex_spark",
          rate_limit: {
            primary_window: {
              used_percent: 70,
              limit_window_seconds: 900,
              reset_at: 1_893_456_300,
            },
          },
        },
      ],
    });

    expect(usage?.primary?.utilization).toBe(1);
    expect(usage?.primary?.windowMinutes).toBe(2);
    expect(usage?.secondary?.windowMinutes).toBeNull();
    expect(usage?.credits).toEqual({ hasCredits: true, unlimited: false, balance: "9.99" });
    expect(usage?.spendControl).toEqual({
      reached: false,
      individualLimit: {
        limit: "25000",
        used: "8000",
        remainingPercent: 68,
        resetsAt: new Date(1_893_456_200 * 1000).toISOString(),
      },
    });
    expect(usage?.additional?.[0]).toMatchObject({
      id: "codex_spark",
      label: "GPT-5.3-Codex-Spark",
      primary: { utilization: 70, windowMinutes: 15 },
    });
  });

  it("parses every rate-limit response-header family and credits metadata", () => {
    const usage = parseCodexUsageHeaders(
      new Headers({
        "x-codex-primary-used-percent": "1",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "1893456000",
        "x-codex-spark-primary-used-percent": "75",
        "x-codex-spark-primary-window-minutes": "10080",
        "x-codex-spark-primary-reset-at": "1893456100",
        "x-codex-spark-limit-name": "gpt-5.3-codex-spark",
        "x-codex-credits-has-credits": "true",
        "x-codex-credits-unlimited": "false",
        "x-codex-credits-balance": "12.50",
      }),
    );

    expect(usage?.primary?.utilization).toBe(1);
    expect(usage?.additional).toEqual([
      {
        id: "codex_spark",
        label: "GPT-5.3-Codex-Spark",
        primary: {
          utilization: 75,
          windowMinutes: 10080,
          resetsAt: new Date(1_893_456_100 * 1000).toISOString(),
        },
        secondary: undefined,
      },
    ]);
    expect(usage?.credits).toEqual({
      hasCredits: true,
      unlimited: false,
      balance: "12.50",
    });
  });

  it("preserves absent versus explicit-null reached type from payloads", () => {
    const rateLimit = {
      primary_window: { used_percent: 100, limit_window_seconds: 300, reset_at: null },
    };
    expect(parseCodexUsagePayload({ rate_limit: rateLimit })?.rateLimitReachedType).toBeUndefined();
    expect(
      parseCodexUsagePayload({
        rate_limit: rateLimit,
        rate_limit_reached_type: null,
      })?.rateLimitReachedType,
    ).toBeNull();
  });

  it("ignores unrecognized reached-reason enum values", () => {
    const usage = parseCodexUsagePayload({
      rate_limit: {
        primary_window: { used_percent: 20, limit_window_seconds: 300, reset_at: null },
      },
      rate_limit_reached_type: { type: "future_reason" },
    });
    expect(usage?.rateLimitReachedType).toBeUndefined();
  });

  it("retains credits-only and spend-control-only account payloads", () => {
    expect(
      parseCodexUsagePayload({
        credits: { has_credits: true, unlimited: false, balance: "4.5" },
      }),
    ).toMatchObject({ credits: { hasCredits: true, unlimited: false, balance: "4.5" } });
    expect(parseCodexUsagePayload({ spend_control: { reached: true } })).toMatchObject({
      spendControl: { reached: true },
    });
  });

  it("transports sparse headers and metadata through the injected usage event", async () => {
    const headers = new Headers({
      "x-codex-spark-primary-used-percent": "75",
      "x-codex-spark-primary-window-minutes": "10080",
      "x-codex-credits-has-credits": "true",
      "x-codex-credits-unlimited": "false",
      "x-codex-credits-balance": "12.50",
    });
    const usage = parseCodexUsageHeaders(headers);
    expect(usage).not.toBeNull();
    if (!usage) return;

    const out: ProviderEvent[] = [];
    for await (const event of translateResponseCodex(
      makeSseStream(codexUsageToSseFrame(usage), [
        { type: "response.created", response: { id: "r1" } },
        { type: "response.completed", response: { status: "completed" } },
      ]),
    )) {
      out.push(event);
    }

    const usageEvent = out.find((event) => event.kind === "usage_limits");
    expect(usageEvent?.kind).toBe("usage_limits");
    if (usageEvent?.kind !== "usage_limits") return;
    expect(usageEvent.usage).toMatchObject({
      additional: [{ id: "codex_spark", primary: { utilization: 75 } }],
      credits: { hasCredits: true, unlimited: false, balance: "12.50" },
    });
  });
});

describe("applyCodexQuotaWarning (provider+scope SoT)", () => {
  afterEach(() => {
    clearRoutingUsage();
    clearUsageLimits();
  });

  function usage(overrides: Partial<CodexUsage>): CodexUsage {
    return {
      primary: { utilization: 20, windowMinutes: 300, resetsAt: null },
      secondary: { utilization: 30, windowMinutes: 10080, resetsAt: null },
      ...overrides,
    };
  }

  it("treats used_percent=1 as one percent, not full exhaustion", () => {
    applyCodexQuotaWarning(
      usage({
        primary: { utilization: 1, windowMinutes: 300, resetsAt: null },
      }),
    );
    expect(getRoutingUsageSnapshot().byProviderScope?.codex?.primary?.routing?.utilizationPct).toBe(
      1,
    );
    expect(providerRouteability("codex", undefined, "gpt-5.6-sol").usable).toBe(true);
  });

  it("account/workspace reached reasons block globally rather than selecting a window", () => {
    applyCodexQuotaWarning(
      usage({
        primary: { utilization: 87, windowMinutes: 300, resetsAt: null },
        secondary: { utilization: 10, windowMinutes: 10080, resetsAt: null },
        rateLimitReachedType: "workspace_member_credits_depleted",
      }),
    );
    expect(getRoutingUsage("codex")?.balanceStatus).toBe("exhausted");
    const route = providerRouteability("codex", undefined, "gpt-5.6-sol");
    expect(route.usable).toBe(false);
    expect(route.blockedReasons.some((reason) => reason.includes("balance exhausted"))).toBe(true);
  });

  it("spend-control reached blocks the account below 100% usage", () => {
    applyCodexQuotaWarning(usage({ spendControl: { reached: true } }));
    expect(providerRouteability("codex", undefined, "gpt-5.6-sol").usable).toBe(false);
  });

  it("an unrecognized additional limit is informational: visible but never blocks any model", () => {
    applyCodexQuotaWarning(
      usage({
        rateLimitReachedType: null,
        additional: [
          {
            id: "priority-access",
            label: "Priority access",
            primary: { utilization: 100, windowMinutes: 10080, resetsAt: null },
          },
        ],
      }),
    );
    expect(providerRouteability("codex", undefined, "gpt-5.6-sol").usable).toBe(true);
    expect(providerRouteability("codex", undefined, "gpt-5.3-codex-spark").usable).toBe(true);
    // Still visible in the full scoped snapshot even though it cannot gate routing.
    const scopes = getRoutingUsageSnapshot().byProviderScope?.codex ?? {};
    expect(scopes["additional-0-primary"]?.applicability).toEqual({ type: "informational" });
    expect(getRoutingUsage("codex")).not.toBeNull();
  });

  it("omitting rateLimitReachedType entirely derives exhaustion from raw percentage alone", () => {
    applyCodexQuotaWarning({
      primary: { utilization: 100, windowMinutes: 300, resetsAt: null },
      secondary: { utilization: 10, windowMinutes: 10080, resetsAt: null },
      // rateLimitReachedType intentionally omitted (undefined, not present).
    });
    expect(providerRouteability("codex", undefined, "gpt-5.6-sol").usable).toBe(false);
  });

  it("clears every scope when usage is null", () => {
    applyCodexQuotaWarning(usage({ rateLimitReachedType: null }));
    expect(getRoutingUsage("codex")).not.toBeNull();
    applyCodexQuotaWarning(null);
    expect(getRoutingUsage("codex")).toBeNull();
  });
});
