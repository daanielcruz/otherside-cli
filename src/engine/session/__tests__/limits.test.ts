import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PROVIDER_ID_VALUES } from "@/kernel/config/provider-ids.ts";
import {
  clearRoutingUsage,
  clearUsageLimits,
  EPOCHLESS_ROUTING_TTL_MS,
  getCurrentWarning,
  getProviderScopeEntries,
  getRoutingUsage,
  getRoutingUsageSnapshot,
  getUsageLimitSnapshot,
  isRoutingUsageExpired,
  normalizeEpochMs,
  normalizeUtilizationPct,
  replaceProviderQuotaObservations,
  routingUsageFromUsageLimits,
  setAllocatedProvidersSource,
  setExtraUsageWarning,
  setProviderQuotaObservation,
  setRoutingUsage,
  setUsageLimits,
  stopUsageSweepTimerForTests,
  subscribe,
  sweepExpiredRoutingUsage,
  type UsageLimitState,
  warningForProvider,
  worstProviderWarning,
} from "../usage/limits.ts";

afterEach(() => {
  clearRoutingUsage();
  clearUsageLimits();
  setExtraUsageWarning("codex", null);
  setExtraUsageWarning("glm", null);
  setExtraUsageWarning("deepseek", null);
  stopUsageSweepTimerForTests();
});

describe("normalizeUtilizationPct", () => {
  it("scales 0..1 ratios up to a 0..100 percentage", () => {
    expect(normalizeUtilizationPct(0.5)).toBe(50);
    expect(normalizeUtilizationPct(0.95)).toBe(95);
    expect(normalizeUtilizationPct(1)).toBe(100);
  });

  it("keeps values already expressed as a percentage", () => {
    expect(normalizeUtilizationPct(50)).toBe(50);
    expect(normalizeUtilizationPct(94.9)).toBe(94.9);
  });

  it("clamps out-of-range percentages into 0..100", () => {
    expect(normalizeUtilizationPct(150)).toBe(100);
    expect(normalizeUtilizationPct(-5)).toBe(0);
  });

  it("returns undefined for non-finite / missing input", () => {
    expect(normalizeUtilizationPct(undefined)).toBeUndefined();
    expect(normalizeUtilizationPct(null)).toBeUndefined();
    expect(normalizeUtilizationPct(Number.NaN)).toBeUndefined();
  });
});

describe("normalizeEpochMs", () => {
  it("upconverts epoch seconds to epoch milliseconds", () => {
    expect(normalizeEpochMs(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it("keeps epoch milliseconds as milliseconds", () => {
    expect(normalizeEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it("parses ISO timestamp strings", () => {
    expect(normalizeEpochMs("2023-11-14T22:13:20.000Z")).toBe(
      Date.parse("2023-11-14T22:13:20.000Z"),
    );
  });

  it("returns undefined for empty / missing input", () => {
    expect(normalizeEpochMs(undefined)).toBeUndefined();
    expect(normalizeEpochMs(null)).toBeUndefined();
    expect(normalizeEpochMs("")).toBeUndefined();
  });
});

describe("setRoutingUsage / getRoutingUsage", () => {
  it("stores normalized routing usage per provider", () => {
    // reset must be in the future: pure reads treat past resets as expired.
    const futureResetSec = Math.floor(Date.now() / 1000) + 3_600;
    setRoutingUsage("glm", {
      trackingStatus: "tracked",
      utilization: 0.96,
      resetEpochMs: futureResetSec,
      balanceStatus: "available",
    });
    const usage = getRoutingUsage("glm");
    expect(usage).not.toBeNull();
    expect(usage?.trackingStatus).toBe("tracked");
    expect(usage?.utilizationPct).toBe(96);
    expect(usage?.resetsAtEpochMs).toBe(futureResetSec * 1000);
    expect(usage?.balanceStatus).toBe("available");
  });

  it("returns null for providers with no state", () => {
    expect(getRoutingUsage("deepseek")).toBeNull();
  });

  it("clear removes process-local state", () => {
    setRoutingUsage("codex", { trackingStatus: "tracked", utilizationPct: 80 });
    expect(getRoutingUsage("codex")).not.toBeNull();
    clearRoutingUsage("codex");
    expect(getRoutingUsage("codex")).toBeNull();
  });
});

describe("routingUsageFromUsageLimits", () => {
  function limits(partial: Partial<UsageLimitState>): UsageLimitState {
    return {
      status: "allowed",
      unifiedRateLimitFallbackAvailable: false,
      isUsingOverage: false,
      ...partial,
    };
  }

  it("marks a rejected limit as balance exhausted", () => {
    const usage = routingUsageFromUsageLimits(limits({ status: "rejected" }));
    expect(usage?.balanceStatus).toBe("exhausted");
  });

  it("treats present utilization as tracked and normalizes to a percentage", () => {
    const usage = routingUsageFromUsageLimits(limits({ utilization: 0.5 }));
    expect(usage?.trackingStatus).toBe("tracked");
    expect(usage?.utilizationPct).toBe(50);
  });

  it("normalizes reset seconds into routing epoch milliseconds", () => {
    const usage = routingUsageFromUsageLimits(
      limits({ utilization: 0.5, resetsAt: 1_700_000_000 }),
    );
    expect(usage?.resetsAtEpochMs).toBe(1_700_000_000_000);
  });

  it("writes Anthropic limits into the routing snapshot SoT", () => {
    setUsageLimits({}, limits({ utilization: 0.96 }));
    expect(getRoutingUsage("anthropic")?.utilizationPct).toBe(96);
    expect(getUsageLimitSnapshot().routing.byProvider.anthropic?.utilizationPct).toBe(96);
    clearUsageLimits();
    expect(getRoutingUsage("anthropic")).toBeNull();
  });
});

describe("warningForProvider reset-epoch gate", () => {
  // Updated from mutating-read: pure read hides stale warning; sweep owns deletion.
  it("hides a stale extra warning once the reset epoch has passed (pure read)", () => {
    setRoutingUsage("codex", { utilizationPct: 96, resetsAtEpochMs: Date.now() - 60_000 });
    setExtraUsageWarning("codex", { message: "Weekly limit reached", severity: "warning" });
    expect(warningForProvider("codex")).toBeNull();
    expect(getRoutingUsage("codex")).toBeNull();
    // Entry still present until sweep — pure read did not delete.
    expect(sweepExpiredRoutingUsage()).toBe(true);
    expect(sweepExpiredRoutingUsage()).toBe(false);
  });

  it("keeps the warning while the reset epoch is in the future", () => {
    setRoutingUsage("codex", { utilizationPct: 96, resetsAtEpochMs: Date.now() + 60_000 });
    setExtraUsageWarning("codex", { message: "Weekly limit reached", severity: "warning" });
    expect(warningForProvider("codex")?.message).toBe("Weekly limit reached");
    setExtraUsageWarning("codex", null);
  });
});

describe("pure reads + sweepExpiredRoutingUsage", () => {
  it("(a) expired-epoch entry: read returns null without mutating; sweep then removes", () => {
    const past = Date.now() - 60_000;
    setRoutingUsage("codex", {
      trackingStatus: "tracked",
      utilizationPct: 99,
      resetsAtEpochMs: past,
    });
    expect(getRoutingUsage("codex")).toBeNull();
    expect(getRoutingUsageSnapshot().byProvider.codex).toBeUndefined();
    // Proves the read left the store entry in place for the sweeper.
    expect(sweepExpiredRoutingUsage()).toBe(true);
    expect(sweepExpiredRoutingUsage()).toBe(false);
  });

  it("(b) epoch-less TTL: older than EPOCHLESS_ROUTING_TTL_MS expires; younger does not", () => {
    const now = Date.now();
    const older = {
      trackingStatus: "tracked" as const,
      observedAtEpochMs: now - EPOCHLESS_ROUTING_TTL_MS - 1,
      balanceStatus: "available" as const,
      utilizationPct: 50,
    };
    const younger = {
      trackingStatus: "tracked" as const,
      observedAtEpochMs: now - 1_000,
      balanceStatus: "available" as const,
      utilizationPct: 50,
    };
    expect(isRoutingUsageExpired(older, now)).toBe(true);
    expect(isRoutingUsageExpired(younger, now)).toBe(false);

    setRoutingUsage("glm", {
      trackingStatus: "tracked",
      utilizationPct: 50,
      observedAtEpochMs: now - EPOCHLESS_ROUTING_TTL_MS - 1,
      balanceStatus: "available",
    });
    setRoutingUsage("deepseek", {
      trackingStatus: "tracked",
      utilizationPct: 50,
      observedAtEpochMs: now - 1_000,
      balanceStatus: "available",
    });
    expect(getRoutingUsage("glm")).toBeNull();
    expect(getRoutingUsage("deepseek")).not.toBeNull();
    expect(sweepExpiredRoutingUsage(now)).toBe(true);
    expect(getRoutingUsage("deepseek")).not.toBeNull();
    expect(sweepExpiredRoutingUsage(now)).toBe(false);
  });

  it('(c) trackingStatus "unknown" epoch-less entries are NOT TTL-expired', () => {
    const now = Date.now();
    const unknownOld = {
      trackingStatus: "unknown" as const,
      observedAtEpochMs: now - EPOCHLESS_ROUTING_TTL_MS * 10,
      balanceStatus: "unknown" as const,
    };
    expect(isRoutingUsageExpired(unknownOld, now)).toBe(false);
    setRoutingUsage("glm", {
      trackingStatus: "unknown",
      observedAtEpochMs: now - EPOCHLESS_ROUTING_TTL_MS * 10,
    });
    expect(getRoutingUsage("glm")).not.toBeNull();
    expect(sweepExpiredRoutingUsage(now)).toBe(false);
  });

  it("(d) sweep emits exactly once for multiple expired providers", () => {
    const past = Date.now() - 60_000;
    setRoutingUsage("codex", {
      trackingStatus: "tracked",
      utilizationPct: 99,
      resetsAtEpochMs: past,
    });
    setRoutingUsage("glm", {
      trackingStatus: "tracked",
      utilizationPct: 99,
      resetsAtEpochMs: past,
    });
    setExtraUsageWarning("codex", { message: "a", severity: "warning" });
    setExtraUsageWarning("glm", { message: "b", severity: "warning" });

    let emissions = 0;
    const unsub = subscribe(() => {
      emissions += 1;
    });
    expect(sweepExpiredRoutingUsage()).toBe(true);
    expect(emissions).toBe(1);
    expect(sweepExpiredRoutingUsage()).toBe(false);
    expect(emissions).toBe(1);
    unsub();
  });

  it('(e) getCurrentWarning returns null when status "rejected" but resetsAt is in the past (seconds)', () => {
    const pastSeconds = Math.floor(Date.now() / 1000) - 60;
    setUsageLimits(
      {},
      {
        status: "rejected",
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
        rateLimitType: "five_hour",
        resetsAt: pastSeconds,
      },
    );
    expect(getCurrentWarning()).toBeNull();
    expect(warningForProvider("anthropic")).toBeNull();
  });
});

describe("worstProviderWarning", () => {
  // worstProviderWarning scans every provider, so leftover warnings from other
  // test files (bun runs all files in one process) must be cleared up front.
  beforeEach(() => {
    clearRoutingUsage();
    clearUsageLimits();
    for (const provider of PROVIDER_ID_VALUES) setExtraUsageWarning(provider, null);
  });

  it("returns null when no provider has an observed warning", () => {
    expect(worstProviderWarning()).toBeNull();
  });

  it("returns the single observed provider warning", () => {
    setExtraUsageWarning("codex", { message: "codex 80%", severity: "warning" });
    expect(worstProviderWarning()).toEqual({ message: "codex 80%", severity: "warning" });
  });

  it("prefers an error over a warning across providers", () => {
    setExtraUsageWarning("codex", { message: "codex 80%", severity: "warning" });
    setExtraUsageWarning("glm", { message: "glm reached", severity: "error" });
    expect(worstProviderWarning()).toEqual({ message: "glm reached", severity: "error" });
  });

  it("skips a provider whose routing entry has expired", () => {
    setExtraUsageWarning("codex", { message: "codex 80%", severity: "warning" });
    setExtraUsageWarning("glm", { message: "glm 96%", severity: "error" });
    setRoutingUsage("glm", {
      trackingStatus: "tracked",
      utilizationPct: 96,
      resetsAtEpochMs: Date.now() - 1000,
      observedAtEpochMs: Date.now() - 2000,
    });
    expect(worstProviderWarning()).toEqual({ message: "codex 80%", severity: "warning" });
  });

  it("includes the Anthropic warning surfaced through getCurrentWarning", () => {
    const futureSeconds = Math.floor(Date.now() / 1000) + 3600;
    setUsageLimits(
      {},
      {
        status: "rejected",
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
        rateLimitType: "five_hour",
        resetsAt: futureSeconds,
      },
    );
    expect(worstProviderWarning()?.severity).toBe("error");
  });
});

describe("worstProviderWarning allocation scoping", () => {
  beforeEach(() => {
    clearRoutingUsage();
    clearUsageLimits();
    for (const provider of PROVIDER_ID_VALUES) setExtraUsageWarning(provider, null);
  });

  afterEach(() => {
    setAllocatedProvidersSource(null);
  });

  it("suppresses warnings for providers outside the live allocation set", () => {
    setExtraUsageWarning("codex", { message: "codex reached", severity: "error" });
    setAllocatedProvidersSource(() => ["glm"]);
    // Codex quota was observed (e.g. /usage tab) but nothing allocates codex.
    expect(worstProviderWarning()).toBeNull();
  });

  it("surfaces warnings for the active provider and running delegated agents", () => {
    setExtraUsageWarning("codex", { message: "codex reached", severity: "error" });
    setExtraUsageWarning("glm", { message: "glm 80%", severity: "warning" });
    setAllocatedProvidersSource(() => ["glm"]);
    expect(worstProviderWarning()).toEqual({ message: "glm 80%", severity: "warning" });
    // A running codex-pinned agent joins the allocation → codex may surface.
    setAllocatedProvidersSource(() => ["glm", "codex"]);
    expect(worstProviderWarning()).toEqual({ message: "codex reached", severity: "error" });
  });

  it("scopes the anthropic plan warning like any other provider", () => {
    const futureSeconds = Math.floor(Date.now() / 1000) + 3600;
    setUsageLimits(
      {},
      {
        status: "rejected",
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
        rateLimitType: "five_hour",
        resetsAt: futureSeconds,
      },
    );
    setAllocatedProvidersSource(() => ["codex"]);
    expect(worstProviderWarning()).toBeNull();
    setAllocatedProvidersSource(() => ["anthropic"]);
    expect(worstProviderWarning()?.severity).toBe("error");
  });

  it("keeps the unscoped behavior when no source is registered", () => {
    setExtraUsageWarning("codex", { message: "codex reached", severity: "error" });
    expect(worstProviderWarning()).toEqual({ message: "codex reached", severity: "error" });
  });

  it("full-roster reads (warningForProvider) stay unscoped for explicit surfaces", () => {
    setExtraUsageWarning("codex", { message: "codex reached", severity: "error" });
    setAllocatedProvidersSource(() => ["glm"]);
    expect(warningForProvider("codex")?.message).toBe("codex reached");
  });
});

describe("setProviderQuotaObservation atomicity", () => {
  it("writes warning + routing with a single emission", () => {
    let emissions = 0;
    const unsub = subscribe(() => {
      emissions += 1;
    });
    setProviderQuotaObservation("codex", {
      warning: { message: "codex reached", severity: "error" },
      routing: {
        trackingStatus: "tracked",
        utilizationPct: 100,
        balanceStatus: "exhausted",
      },
    });
    expect(emissions).toBe(1);
    expect(warningForProvider("codex")?.message).toBe("codex reached");
    expect(getRoutingUsage("codex")?.balanceStatus).toBe("exhausted");
    unsub();
    setExtraUsageWarning("codex", null);
  });

  it("does not emit when the observation changes nothing", () => {
    setExtraUsageWarning("codex", null);
    clearRoutingUsage("codex");
    let emissions = 0;
    const unsub = subscribe(() => {
      emissions += 1;
    });
    setProviderQuotaObservation("codex", { warning: null, routing: null });
    expect(emissions).toBe(0);
    unsub();
  });
});

describe("replaceProviderQuotaObservations (atomic multi-scope replacement)", () => {
  afterEach(() => {
    clearRoutingUsage();
    clearUsageLimits();
    setExtraUsageWarning("codex", null);
  });

  function routing(utilizationPct: number, resetsAtEpochMs?: number) {
    return {
      trackingStatus: "tracked" as const,
      balanceStatus: "unknown" as const,
      utilizationPct,
      observedAtEpochMs: Date.now(),
      ...(resetsAtEpochMs !== undefined ? { resetsAtEpochMs } : {}),
    };
  }

  it("writes the whole scope map atomically and emits at most once", () => {
    let emissions = 0;
    const unsub = subscribe(() => {
      emissions += 1;
    });
    replaceProviderQuotaObservations("codex", [
      {
        scopeKey: "primary",
        displayLabel: "Codex primary",
        applicability: { type: "global" },
        warning: null,
        routing: routing(40),
      },
      {
        scopeKey: "secondary",
        displayLabel: "Codex secondary",
        applicability: { type: "global" },
        warning: null,
        routing: routing(90),
      },
    ]);
    expect(emissions).toBe(1);

    const scopes = getUsageLimitSnapshot().routing.byProviderScope?.codex ?? {};
    expect(Object.keys(scopes).sort()).toEqual(["primary", "secondary"]);
    // Legacy derived-worst getter picks the tightest live scope.
    expect(getRoutingUsage("codex")?.utilizationPct).toBe(90);
    unsub();
  });

  it("a scope key omitted from a later call is dropped (stale deletion), not left behind", () => {
    replaceProviderQuotaObservations("codex", [
      {
        scopeKey: "primary",
        displayLabel: "Codex primary",
        applicability: { type: "global" },
        warning: null,
        routing: routing(40),
      },
      {
        scopeKey: "spark",
        displayLabel: "Spark",
        applicability: { type: "family", id: "spark" },
        warning: null,
        routing: routing(100),
      },
    ]);
    expect(getUsageLimitSnapshot().routing.byProviderScope?.codex?.spark).toBeDefined();

    replaceProviderQuotaObservations("codex", [
      {
        scopeKey: "primary",
        displayLabel: "Codex primary",
        applicability: { type: "global" },
        warning: null,
        routing: routing(10),
      },
    ]);
    expect(getUsageLimitSnapshot().routing.byProviderScope?.codex?.spark).toBeUndefined();
    expect(getRoutingUsage("codex")?.utilizationPct).toBe(10);
  });

  it("emits nothing when replacing an already-empty provider with empty", () => {
    let emissions = 0;
    const unsub = subscribe(() => {
      emissions += 1;
    });
    replaceProviderQuotaObservations("codex", []);
    expect(emissions).toBe(0);
    unsub();
  });

  it("empty observations clears every scope for the provider", () => {
    replaceProviderQuotaObservations("codex", [
      {
        scopeKey: "primary",
        displayLabel: "Codex primary",
        applicability: { type: "global" },
        warning: { message: "hit", severity: "error" },
        routing: routing(100),
      },
    ]);
    expect(getRoutingUsage("codex")).not.toBeNull();
    replaceProviderQuotaObservations("codex", []);
    expect(getRoutingUsage("codex")).toBeNull();
    expect(warningForProvider("codex")).toBeNull();
  });

  it("sweep removes only the individual expired scope, keeping a live sibling scope intact", () => {
    const past = Date.now() - 60_000;
    const future = Date.now() + 60_000;
    replaceProviderQuotaObservations("codex", [
      {
        scopeKey: "primary",
        displayLabel: "Codex primary",
        applicability: { type: "global" },
        warning: { message: "hit", severity: "error" },
        routing: routing(100, past),
      },
      {
        scopeKey: "secondary",
        displayLabel: "Codex secondary",
        applicability: { type: "global" },
        warning: null,
        routing: routing(40, future),
      },
    ]);
    expect(sweepExpiredRoutingUsage()).toBe(true);
    const scopes = getUsageLimitSnapshot().routing.byProviderScope?.codex ?? {};
    expect(scopes.primary).toBeUndefined();
    expect(scopes.secondary).toBeDefined();
    expect(sweepExpiredRoutingUsage()).toBe(false);
  });

  it("getProviderScopeEntries and getUsageLimitSnapshot deep-copy entries (mutating the return never touches the SoT)", () => {
    replaceProviderQuotaObservations("codex", [
      {
        scopeKey: "primary",
        displayLabel: "Codex primary",
        applicability: { type: "global" },
        warning: { message: "m", severity: "warning" },
        routing: routing(40),
      },
    ]);

    const entries = getProviderScopeEntries("codex");
    const entry = entries[0];
    expect(entry).toBeDefined();
    if (entry) {
      entry.displayLabel = "mutated";
      if (entry.warning) entry.warning.message = "mutated";
      if (entry.routing) entry.routing.utilizationPct = 1;
    }
    const fresh = getProviderScopeEntries("codex")[0];
    expect(fresh?.displayLabel).toBe("Codex primary");
    expect(fresh?.warning?.message).toBe("m");
    expect(fresh?.routing?.utilizationPct).toBe(40);

    const scoped = getUsageLimitSnapshot().routing.byProviderScope?.codex?.primary;
    if (scoped) scoped.displayLabel = "mutated-again";
    expect(getUsageLimitSnapshot().routing.byProviderScope?.codex?.primary?.displayLabel).toBe(
      "Codex primary",
    );
  });

  it("getUsageLimitSnapshot copies raw/limits (mutating the return never touches the SoT)", () => {
    const snapshot = getUsageLimitSnapshot();
    // Intentionally injects an arbitrary key to prove the returned object is a
    // copy, not a live reference.
    // biome-ignore lint/suspicious/noExplicitAny: see above
    (snapshot.raw as any).__mutated_test_key = { utilization: 1, resetsAt: 1 };
    // biome-ignore lint/suspicious/noExplicitAny: same as above, for `limits`.
    (snapshot.limits as any).__mutated_test_key = true;
    const fresh = getUsageLimitSnapshot();
    expect(Object.keys(fresh.raw)).not.toContain("__mutated_test_key");
    expect(Object.keys(fresh.limits)).not.toContain("__mutated_test_key");
  });
});
