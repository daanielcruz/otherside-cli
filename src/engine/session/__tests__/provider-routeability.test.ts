import { afterEach, describe, expect, it } from "bun:test";
import { clearRoutingUsage, setRoutingUsage } from "@/engine/session/usage/limits.ts";
import { applyQuotaWarning } from "@/engine/session/usage/quota-warning.ts";
import { clearProviderCooldowns, markProviderCooldown } from "../usage/provider-health.ts";
import { providerRouteability } from "../usage/provider-routeability.ts";

afterEach(() => {
  clearRoutingUsage();
  clearProviderCooldowns();
});

describe("providerRouteability model-scoped cooldowns", () => {
  it("keeps a sibling model routeable for the same provider", () => {
    markProviderCooldown("anthropic", Date.now() + 60_000, "rate_limited", "claude-fable-5");

    expect(providerRouteability("anthropic", undefined, "claude-fable-5").usable).toBe(false);
    expect(providerRouteability("anthropic", undefined, "claude-opus-4-8").usable).toBe(true);
  });

  it("blocks every model under a provider-wide cooldown", () => {
    markProviderCooldown("anthropic", Date.now() + 60_000, "rate_limited");

    expect(providerRouteability("anthropic", undefined, "claude-fable-5").usable).toBe(false);
    expect(providerRouteability("anthropic", undefined, "claude-opus-4-8").usable).toBe(false);
  });
});

describe("providerRouteability quota gates (100% / exhaustion, no exemption)", () => {
  it("blocks at 100% utilization when balance availability is unknown", () => {
    setRoutingUsage("codex", {
      trackingStatus: "tracked",
      utilizationPct: 100,
      balanceStatus: "unknown",
    });
    const result = providerRouteability("codex");
    expect(result.usable).toBe(false);
    expect(result.quotaBlocked).toBe(true);
    expect(result.blockedReasons.some((reason) => reason.includes("utilization"))).toBe(true);
  });

  it("keeps a 100% provider usable when balance is explicitly available", () => {
    setRoutingUsage("codex", {
      trackingStatus: "tracked",
      utilizationPct: 100,
      balanceStatus: "available",
    });
    const result = providerRouteability("codex");
    expect(result.usable).toBe(true);
    expect(result.quotaBlocked).toBe(false);
  });

  it("never blocks below 100% on the raw (untruncated) percentage", () => {
    setRoutingUsage("codex", { trackingStatus: "tracked", utilizationPct: 99.9 });
    const result = providerRouteability("codex");
    expect(result.usable).toBe(true);
    expect(result.quotaBlocked).toBe(false);
  });

  it("blocks an exhausted balance and names the reset time when known", () => {
    setRoutingUsage("codex", {
      trackingStatus: "tracked",
      utilizationPct: 40,
      balanceStatus: "exhausted",
      resetsAtEpochMs: Date.now() + 3_600_000,
    });
    const result = providerRouteability("codex");
    expect(result.usable).toBe(false);
    expect(result.quotaBlocked).toBe(true);
    const reason = result.blockedReasons.find((entry) => entry.includes("balance exhausted"));
    expect(reason).toBeDefined();
    expect(reason).toContain("resets");
  });

  it("applies the same gates to the active provider (exemption removed)", () => {
    setRoutingUsage("codex", { trackingStatus: "untracked", balanceStatus: "exhausted" });
    const asActive = providerRouteability("codex", "codex");
    expect(asActive.usable).toBe(false);
    expect(asActive.quotaBlocked).toBe(true);
    expect(asActive.notes.some((note) => note.includes("exempt"))).toBe(false);
  });

  it("exhausted → usable re-entry is immediate on a recovery observation", () => {
    applyQuotaWarning(
      "codex",
      [
        {
          label: "Codex session limit",
          utilization: 87,
          resetsAt: null,
          provider: "codex",
          trackingStatus: "tracked",
        },
      ],
      { exhausted: true, label: "Codex session limit" },
    );
    expect(providerRouteability("codex").usable).toBe(false);

    // Next refresh reports recovery: eligibility is live SoT state, never a
    // synthetic cooldown — the provider is usable again on the very next check.
    applyQuotaWarning(
      "codex",
      [
        {
          label: "Codex session limit",
          utilization: 12,
          resetsAt: null,
          provider: "codex",
          trackingStatus: "tracked",
        },
      ],
      { exhausted: false },
    );
    const recovered = providerRouteability("codex");
    expect(recovered.usable).toBe(true);
    expect(recovered.quotaBlocked).toBe(false);
    expect(recovered.routing.state.balanceStatus).toBe("available");
  });

  it("exhausted → usable re-entry is immediate once the reset epoch passes", () => {
    setRoutingUsage("codex", {
      trackingStatus: "tracked",
      utilizationPct: 100,
      balanceStatus: "exhausted",
      resetsAtEpochMs: Date.now() - 1_000,
      observedAtEpochMs: Date.now() - 2_000,
    });
    // The expired entry reads as unobserved — no lingering block.
    const result = providerRouteability("codex");
    expect(result.usable).toBe(true);
    expect(result.routing.source).toBe("unobserved");
  });
});
