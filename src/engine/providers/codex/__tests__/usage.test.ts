import { afterEach, describe, expect, it } from "bun:test";
import {
  clearRoutingUsage,
  clearUsageLimits,
  getRoutingUsage,
  getRoutingUsageSnapshot,
} from "@/engine/session/usage/limits.ts";
import { providerRouteability } from "@/engine/session/usage/provider-routeability.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import { translateResponseCodex } from "../translate.ts";
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
      "x-codex-rate-limit-reached-type": "primary_window",
    });

    const usage = parseCodexUsageHeaders(headers);
    expect(usage).not.toBeNull();
    if (!usage) return;

    expect(usage.primary?.utilization).toBe(42);
    expect(usage.primary?.windowMinutes).toBe(60);
    expect(usage.secondary?.utilization).toBe(84);
    expect(usage.secondary?.windowMinutes).toBe(1440);
    expect(usage.planType).toBe("plus");
    expect(usage.rateLimitReachedType).toBe("primary_window");

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
    expect(usageEvent.usage?.rateLimitReachedType).toBe("primary_window");
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

  it("explicit null reached type frees the global windows but does not suppress a 100% Spark additional scope", () => {
    applyCodexQuotaWarning(
      usage({
        rateLimitReachedType: null,
        additional: [
          {
            id: "gpt-5.3-codex-spark",
            label: "GPT-5.3-Codex-Spark",
            primary: { utilization: 100, windowMinutes: 10080, resetsAt: null },
          },
        ],
      }),
    );
    // Global windows: explicit not-reached beats the (already low) raw percentage.
    expect(providerRouteability("codex", undefined, "gpt-5.6-sol").usable).toBe(true);
    // Spark family: raw 100% still blocks Spark — additional scopes never
    // receive the wire-level reached-type override.
    expect(providerRouteability("codex", undefined, "gpt-5.3-codex-spark").usable).toBe(false);
  });

  it("non-null reached type marks only that global window exhausted; the sibling global window derives normally", () => {
    applyCodexQuotaWarning(
      usage({
        primary: { utilization: 87, windowMinutes: 300, resetsAt: null },
        secondary: { utilization: 10, windowMinutes: 10080, resetsAt: null },
        rateLimitReachedType: "primary_window",
      }),
    );
    expect(getRoutingUsage("codex")?.balanceStatus).toBe("exhausted");
    const route = providerRouteability("codex", undefined, "gpt-5.6-sol");
    expect(route.usable).toBe(false);
    expect(route.blockedReasons.some((reason) => reason.includes("balance exhausted"))).toBe(true);
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
