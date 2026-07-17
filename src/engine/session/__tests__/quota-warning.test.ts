import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { applyAnthropicUsageLimits } from "@/engine/providers/anthropic/usage.ts";
import { applyAntigravityQuotaWarning } from "@/engine/providers/antigravity/usage.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import { applyCodexQuotaWarning } from "@/engine/providers/codex/usage.ts";
import { applyKimiQuotaWarning } from "@/engine/providers/kimi/usage.ts";
import { applyPlanQuotaWarning } from "@/engine/session/usage/plan-quota.ts";
import {
  clearRoutingUsage,
  clearUsageLimits,
  getRoutingUsage,
  subscribe,
  warningForProvider,
} from "../usage/limits.ts";
import { applyQuotaWarning } from "../usage/quota-warning.ts";

beforeAll(() => registerAllProviders());

afterEach(() => {
  clearRoutingUsage();
  clearUsageLimits();
});

describe("applyQuotaWarning routing wiring", () => {
  it("populates routing usage for provider-tagged candidates", () => {
    applyQuotaWarning("codex", [
      {
        label: "Codex weekly limit",
        utilization: 96,
        resetsAt: null,
        provider: "codex",
        trackingStatus: "tracked",
      },
    ]);
    const usage = getRoutingUsage("codex");
    expect(usage).not.toBeNull();
    expect(usage?.trackingStatus).toBe("tracked");
    expect(usage?.utilizationPct).toBe(96);
  });

  it("does not invent a provider for untagged candidates", () => {
    applyQuotaWarning("codex", [{ label: "Anonymous limit", utilization: 99, resetsAt: null }]);
    // No candidate provider id => nothing to wire; routing usage stays empty for every provider.
    expect(getRoutingUsage("codex")).toBeNull();
    expect(getRoutingUsage("glm")).toBeNull();
  });

  it("clears stale routing usage when refreshed provider data is unavailable", () => {
    applyQuotaWarning("codex", [
      {
        label: "Codex weekly limit",
        utilization: 96,
        resetsAt: null,
        provider: "codex",
        trackingStatus: "tracked",
      },
    ]);
    expect(getRoutingUsage("codex")).not.toBeNull();
    applyQuotaWarning("codex", []);
    expect(getRoutingUsage("codex")).toBeNull();
  });

  it("keeps the worst (tightest) window for the provider", () => {
    applyQuotaWarning("codex", [
      {
        label: "primary",
        utilization: 40,
        resetsAt: null,
        provider: "codex",
        trackingStatus: "tracked",
      },
      {
        label: "secondary",
        utilization: 97,
        resetsAt: null,
        provider: "codex",
        trackingStatus: "tracked",
      },
    ]);
    expect(getRoutingUsage("codex")?.utilizationPct).toBe(97);
  });
});

describe("exhaustion resolution: explicit signal wins, 100% gate is the fallback", () => {
  const tracked = (utilization: number) =>
    ({
      label: "Codex weekly limit",
      utilization,
      resetsAt: null,
      provider: "codex",
      trackingStatus: "tracked",
    }) as const;

  it("derived: 100% utilization is exhaustion (error warning + exhausted balance)", () => {
    applyQuotaWarning("codex", [tracked(100)]);
    expect(getRoutingUsage("codex")?.balanceStatus).toBe("exhausted");
    expect(warningForProvider("codex")?.severity).toBe("error");
    expect(warningForProvider("codex")?.message).toBe("[Codex] 100% Weekly · resets unknown");
  });

  it("derived: 99.9% is never exhaustion (amber only, raw percentage)", () => {
    applyQuotaWarning("codex", [tracked(99.9)]);
    expect(getRoutingUsage("codex")?.balanceStatus).toBe("unknown");
    expect(warningForProvider("codex")?.severity).toBe("warning");
  });

  it("explicit exhausted:true wins below 100%", () => {
    applyQuotaWarning("codex", [tracked(87)], {
      exhausted: true,
      label: "Codex session limit",
      resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(getRoutingUsage("codex")?.balanceStatus).toBe("exhausted");
    const warning = warningForProvider("codex");
    expect(warning?.severity).toBe("error");
    expect(warning?.message).toContain(" Weekly · ");
    expect(warning?.message).not.toContain("primary");
    expect(warning?.message).not.toContain("session");
    expect(warning?.message).toContain("resets");
  });

  it("explicit exhausted:false beats a rounded 100%", () => {
    applyQuotaWarning("codex", [tracked(100)], { exhausted: false });
    expect(getRoutingUsage("codex")?.balanceStatus).toBe("available");
    // Still amber-worthy usage, but never an error without real exhaustion.
    expect(warningForProvider("codex")?.severity).toBe("warning");
  });

  it("a refresh that shows recovery clears exhaustion atomically", () => {
    applyQuotaWarning("codex", [tracked(87)], { exhausted: true, label: "Codex session limit" });
    expect(getRoutingUsage("codex")?.balanceStatus).toBe("exhausted");
    applyQuotaWarning("codex", [tracked(12)], { exhausted: false });
    expect(getRoutingUsage("codex")?.balanceStatus).toBe("available");
    expect(warningForProvider("codex")).toBeNull();
  });

  it("emits a single SoT notification per observation (warning + routing together)", () => {
    let emissions = 0;
    const unsub = subscribe(() => {
      emissions += 1;
    });
    applyQuotaWarning("codex", [tracked(100)]);
    expect(emissions).toBe(1);
    unsub();
  });
});

describe("applyCodexQuotaWarning explicit wire signal", () => {
  it("rateLimitReachedType marks exhaustion below 100% and names the spent window", () => {
    applyCodexQuotaWarning({
      primary: { utilization: 87, windowMinutes: 300, resetsAt: null },
      secondary: { utilization: 40, windowMinutes: 10080, resetsAt: null },
      rateLimitReachedType: "primary_window",
    });
    expect(getRoutingUsage("codex")?.balanceStatus).toBe("exhausted");
    const warning = warningForProvider("codex");
    expect(warning?.severity).toBe("error");
    expect(warning?.message).toBe("[Codex] 87% Weekly · resets unknown");
  });

  it("a null rateLimitReachedType is an explicit not-reached that beats 100%", () => {
    applyCodexQuotaWarning({
      primary: { utilization: 100, windowMinutes: 300, resetsAt: null },
      secondary: { utilization: 10, windowMinutes: 10080, resetsAt: null },
      rateLimitReachedType: null,
    });
    expect(getRoutingUsage("codex")?.balanceStatus).toBe("available");
    expect(warningForProvider("codex")?.severity).toBe("warning");
  });

  it("recovery on the next refresh re-admits codex immediately", () => {
    applyCodexQuotaWarning({
      primary: { utilization: 99, windowMinutes: 300, resetsAt: null },
      rateLimitReachedType: "primary_window",
    });
    expect(getRoutingUsage("codex")?.balanceStatus).toBe("exhausted");
    applyCodexQuotaWarning({
      primary: { utilization: 3, windowMinutes: 300, resetsAt: null },
      rateLimitReachedType: null,
    });
    expect(getRoutingUsage("codex")?.balanceStatus).toBe("available");
    expect(warningForProvider("codex")).toBeNull();
  });
});

describe("provider usage helpers tag the producing provider", () => {
  it("applyCodexQuotaWarning wires codex routing usage", () => {
    applyCodexQuotaWarning({
      primary: { utilization: 95, windowMinutes: 300, resetsAt: null },
      secondary: { utilization: 10, windowMinutes: 10080, resetsAt: null },
    });
    const usage = getRoutingUsage("codex");
    expect(usage).not.toBeNull();
    expect(usage?.trackingStatus).toBe("tracked");
    expect(usage?.utilizationPct).toBe(95);
  });

  it("applyAnthropicUsageLimits wires anthropic routing usage", () => {
    applyAnthropicUsageLimits({
      fiveHour: { utilization: 96, resetsAt: null },
      sevenDay: { utilization: 10, resetsAt: null },
    });
    expect(getRoutingUsage("anthropic")?.trackingStatus).toBe("tracked");
    expect(getRoutingUsage("anthropic")?.utilizationPct).toBe(96);
  });

  it("applyKimiQuotaWarning wires kimi routing usage", () => {
    applyKimiQuotaWarning({
      limits: [{ label: "Weekly", used: 97, limit: 100, resetsAt: null }],
    });
    expect(getRoutingUsage("kimi")?.trackingStatus).toBe("tracked");
    expect(getRoutingUsage("kimi")?.utilizationPct).toBe(97);
  });

  it("applyAntigravityQuotaWarning wires antigravity routing usage", () => {
    applyAntigravityQuotaWarning(
      {
        groups: [
          {
            displayName: "Gemini Quota",
            description: "",
            buckets: [
              {
                bucketId: "weekly",
                displayName: "Weekly",
                remainingFraction: 0.02,
                utilization: 98,
                resetsAt: null,
              },
            ],
          },
        ],
      },
      "gemini-3-flash-low",
    );
    expect(getRoutingUsage("antigravity")?.trackingStatus).toBe("tracked");
    expect(getRoutingUsage("antigravity")?.utilizationPct).toBe(98);
  });

  it("applyPlanQuotaWarning wires generic plan quota routing usage", () => {
    applyPlanQuotaWarning(
      "glm",
      {
        level: null,
        windows: [{ label: "Tokens", limit: { utilization: 99, resetsAt: null } }],
      },
      "GLM",
    );
    expect(getRoutingUsage("glm")?.trackingStatus).toBe("tracked");
    expect(getRoutingUsage("glm")?.utilizationPct).toBe(99);
  });

  it("applyPlanQuotaWarning does not duplicate a trailing limit in labels", () => {
    applyPlanQuotaWarning(
      "xai",
      {
        level: null,
        windows: [{ label: "Weekly limit", limit: { utilization: 86, resetsAt: null } }],
      },
      "xAI",
    );
    expect(warningForProvider("xai")?.message).toBe("[xAI] 86% Weekly · resets unknown");
  });

  it("applyPlanQuotaWarning appends limit to bare window labels", () => {
    applyPlanQuotaWarning(
      "glm",
      {
        level: null,
        windows: [{ label: "Weekly quota", limit: { utilization: 71, resetsAt: null } }],
      },
      "GLM",
    );
    expect(warningForProvider("glm")?.message).toBe("[Z.AI] 71% Weekly · resets unknown");
  });
});
