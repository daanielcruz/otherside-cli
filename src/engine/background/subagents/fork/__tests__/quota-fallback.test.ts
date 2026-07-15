import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveWorkflowAgentModelContextDetailed } from "@/engine/background/workflows/runtime/subagent/bridge.ts";
import { setCredentialsLoaderForTests } from "@/engine/model/tier/resolver.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import {
  clearRoutingUsage,
  clearUsageLimits,
  setRoutingUsage,
  setUsageLimits,
  stopUsageSweepTimerForTests,
} from "@/engine/session/usage/limits.ts";
import {
  clearProviderCooldowns,
  markProviderCooldown,
} from "@/engine/session/usage/provider-health.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import type { CredentialsBundle } from "@/kernel/storage/credentials.ts";
import {
  resolveSubagentRoutingForDispatch,
  resolveToolTierOverride,
  resolveToolTierQuotaReroute,
} from "../routing.ts";

registerAllProviders();

// Hermetic bundle: codex (general rank 1) and anthropic (general rank 2) are
// credentialed; every other provider is skipped for missing credentials, which
// must never count as a quota fallback.
const CODEX_AND_ANTHROPIC = (): CredentialsBundle =>
  ({
    codex: { accessToken: "x" },
    anthropic: { accessToken: "x" },
  }) as unknown as CredentialsBundle;

// ctx.model is a scout-tier model so the "caller model already satisfies the
// tier" early return never short-circuits the general-tier cascade under test.
function ctxWith(quotaFallbackEnabled: boolean | undefined): RequestContext {
  return {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    effort: null,
    permissionMode: "default",
    multiproviderEnabled: true,
    ...(quotaFallbackEnabled !== undefined ? { quotaFallbackEnabled } : {}),
  } as RequestContext;
}

function blockCodexQuota(): void {
  setRoutingUsage("codex", {
    trackingStatus: "tracked",
    utilizationPct: 100,
    resetsAtEpochMs: Date.now() + 3_600_000,
    balanceStatus: "unknown",
  });
}

const TEST_DEF: Parameters<typeof resolveSubagentRoutingForDispatch>[1] = {
  id: "test-agent",
  name: "Test Agent",
  description: "Test definition",
  body: "Test body",
  tools: null,
  disallowedTools: null,
  model: {},
  background: false,
  scope: "builtin",
};

const BASE_INVOCATION: Parameters<typeof resolveSubagentRoutingForDispatch>[2] = {
  subagentType: "test-agent",
  prompt: "Test prompt",
};

beforeEach(() => {
  clearRoutingUsage();
  clearUsageLimits();
  clearProviderCooldowns();
  setCredentialsLoaderForTests(CODEX_AND_ANTHROPIC);
});

afterEach(() => {
  setCredentialsLoaderForTests(null);
  clearRoutingUsage();
  clearUsageLimits();
  clearProviderCooldowns();
  stopUsageSweepTimerForTests();
});

describe("quota refusal for inherited provider routes", () => {
  it("refuses a launch with no routing overrides when the parent provider is exhausted", async () => {
    setRoutingUsage("anthropic", {
      trackingStatus: "tracked",
      utilizationPct: 40,
      balanceStatus: "exhausted",
    });
    const result = await resolveSubagentRoutingForDispatch(
      ctxWith(undefined),
      TEST_DEF,
      BASE_INVOCATION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("QuotaExhaustedError");
      expect(result.error).toContain("anthropic");
    }
  });

  it("refuses a same-provider model override when the provider is exhausted", async () => {
    setRoutingUsage("anthropic", {
      trackingStatus: "tracked",
      utilizationPct: 40,
      balanceStatus: "exhausted",
    });
    const context = ctxWith(undefined);
    const result = await resolveSubagentRoutingForDispatch(context, TEST_DEF, {
      ...BASE_INVOCATION,
      modelOverride: context.model,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("QuotaExhaustedError");
      expect(result.error).toContain("anthropic");
    }
  });

  it("re-admits the same inherited dispatch immediately after recovery", async () => {
    setRoutingUsage("anthropic", {
      trackingStatus: "tracked",
      utilizationPct: 40,
      balanceStatus: "exhausted",
    });
    const context = ctxWith(undefined);
    const refused = await resolveSubagentRoutingForDispatch(context, TEST_DEF, BASE_INVOCATION);
    expect(refused.ok).toBe(false);

    clearRoutingUsage();
    setRoutingUsage("anthropic", {
      trackingStatus: "tracked",
      utilizationPct: 10,
      balanceStatus: "available",
    });
    const recovered = await resolveSubagentRoutingForDispatch(context, TEST_DEF, BASE_INVOCATION);
    expect(recovered.ok).toBe(true);
  });
});

describe("quota fallback gate (bare tier dispatch)", () => {
  it("fallback disabled: fails the step when a quota-blocked viable candidate is skipped", () => {
    blockCodexQuota();
    const result = resolveToolTierOverride(ctxWith(false), "general");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Quota fallback is disabled");
      expect(result.error).toContain("codex/gpt-5.6-sol");
    }
  });

  it("fallback enabled (default, flag absent): reroutes past the quota-blocked candidate", () => {
    blockCodexQuota();
    const result = resolveToolTierOverride(ctxWith(undefined), "general");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ctx.provider).toBe("anthropic");
  });

  it("fallback disabled: missing-credential skips alone do not fail the step", () => {
    // No quota state anywhere: rank 1 (codex) is credentialed and usable, so
    // resolution lands on it; uncredentialed providers are not quota skips.
    const result = resolveToolTierOverride(ctxWith(false), "general");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ctx.provider).toBe("codex");
  });
});

describe("quota fallback gate (mid-run reroute)", () => {
  it("fallback disabled: refuses the reroute", () => {
    const result = resolveToolTierQuotaReroute(ctxWith(false), "general", "codex");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Quota fallback is disabled");
  });

  it("fallback enabled: reroutes to the next usable candidate", () => {
    const result = resolveToolTierQuotaReroute(ctxWith(true), "general", "codex");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ctx.provider).toBe("anthropic");
  });

  it("fallback enabled + no candidate left: failure is NOT gated (default output untouched)", () => {
    setCredentialsLoaderForTests(
      () => ({ codex: { accessToken: "x" } }) as unknown as CredentialsBundle,
    );
    const result = resolveToolTierQuotaReroute(ctxWith(true), "general", "codex");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.gated).not.toBe(true);
  });
});

describe("quota fallback gate (verify-panel regressions)", () => {
  it("caller's own tier model quota-blocked by a model-scoped window fails instead of silently rerouting", () => {
    // Fable weekly spent: the caller (anthropic/claude-fable-5, general rank 2)
    // is quota-displaced like any other candidate — no active-provider exemption.
    setUsageLimits(
      { seven_day_fable: { utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 3600 } },
      { status: "allowed", unifiedRateLimitFallbackAvailable: false, isUsingOverage: false },
    );
    const ctx = {
      ...ctxWith(false),
      provider: "anthropic",
      model: "claude-fable-5",
    } as RequestContext;
    const result = resolveToolTierOverride(ctx, "general");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gated).toBe(true);
      expect(result.error).toContain("anthropic/claude-fable-5");
    }
  });

  it("active provider under transient cooldown + high utilization is a cooldown skip, not a gate failure", () => {
    setRoutingUsage("codex", {
      trackingStatus: "tracked",
      utilizationPct: 96,
      resetsAtEpochMs: Date.now() + 3_600_000,
      balanceStatus: "available",
    });
    markProviderCooldown("codex", Date.now() + 60_000, "rate_limited", null);
    const ctx = { ...ctxWith(false), provider: "codex", model: "gpt-5.6-sol" } as RequestContext;
    const result = resolveToolTierOverride(ctx, "general");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ctx.provider).toBe("anthropic");
  });
});

describe("quota fallback gate (workflow bridge)", () => {
  const bridgeOpts = { tier: "general", diversify: false } as const;

  it("fallback disabled: workflow tier routing fails when rank 1 is quota-blocked", () => {
    blockCodexQuota();
    const result = resolveWorkflowAgentModelContextDetailed(ctxWith(false), bridgeOpts);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Quota fallback is disabled");
    expect(result.error).toContain("codex/gpt-5.6-sol");
  });

  it("fallback enabled (default): workflow tier routing reroutes past the blocked candidate", () => {
    blockCodexQuota();
    const result = resolveWorkflowAgentModelContextDetailed(ctxWith(undefined), bridgeOpts);
    expect(result.ok).toBe(true);
    expect(result.ctx.provider).toBe("anthropic");
  });

  it("fallback disabled: healthy roster still resolves normally", () => {
    const result = resolveWorkflowAgentModelContextDetailed(ctxWith(false), bridgeOpts);
    expect(result.ok).toBe(true);
    expect(result.ctx.provider).toBe("codex");
  });
});
