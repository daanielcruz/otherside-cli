import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveWorkflowAgentModelContextDetailed } from "@/engine/background/workflows/runtime/subagent/bridge.ts";
import { setCredentialsLoaderForTests } from "@/engine/model/tier/usability.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import {
  clearRoutingUsage,
  clearUsageLimits,
  replaceProviderQuotaObservations,
  setRoutingUsage,
  stopUsageSweepTimerForTests,
} from "@/engine/session/usage/limits.ts";
import {
  clearProviderCooldowns,
  markProviderCooldown,
} from "@/engine/session/usage/provider-health.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import type { CredentialsBundle } from "@/kernel/storage/credentials.ts";
import {
  inheritedRouteRefusal,
  resolveSubagentRoutingForDispatch,
  resolveToolModelOverride,
  resolveToolTierOverride,
  resolveToolTierQuotaReroute,
} from "../routing.ts";

registerAllProviders();

// Hermetic bundle: anthropic (emperor rank 1) and codex (emperor rank 2) are
// credentialed; every other provider is skipped for missing credentials, which
// must never count as a quota fallback.
const CODEX_AND_ANTHROPIC = (): CredentialsBundle =>
  ({
    codex: { accessToken: "x" },
    anthropic: { accessToken: "x" },
  }) as unknown as CredentialsBundle;

// ctx.model is a samurai-tier model so the "caller model already satisfies the
// tier" early return never short-circuits the emperor-tier cascade under test.
function ctxWith(quotaFallbackEnabled: boolean | undefined): RequestContext {
  return {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    effort: null,
    permissionMode: "default",
    orchestrationMode: "feudalism",
    ...(quotaFallbackEnabled !== undefined ? { quotaFallbackEnabled } : {}),
  } as RequestContext;
}

function blockAnthropicQuota(): void {
  setRoutingUsage("anthropic", {
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
    const context = {
      ...ctxWith(undefined),
      orchestrationMode: "disabled" as const,
    };
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

  it("quota remedies name only routes legal to each orchestration mode", () => {
    setRoutingUsage("anthropic", {
      trackingStatus: "tracked",
      utilizationPct: 40,
      balanceStatus: "exhausted",
    });

    const disabled = resolveToolModelOverride(
      { ...ctxWith(undefined), orchestrationMode: "disabled" as const },
      "claude-haiku-4-5",
    );
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) {
      expect(disabled.error).toContain("current provider");
      expect(disabled.error).not.toContain("provider/model");
      expect(disabled.error).not.toContain("tier");
    }

    const defaultMode = resolveToolModelOverride(
      { ...ctxWith(undefined), orchestrationMode: "default" as const },
      "claude-haiku-4-5",
    );
    expect(defaultMode.ok).toBe(false);
    if (!defaultMode.ok) {
      expect(defaultMode.error).toContain("Pin another provider/model");
      expect(defaultMode.error).not.toContain("tier");
    }

    const experimental = resolveToolModelOverride(ctxWith(undefined), "claude-haiku-4-5");
    expect(experimental.ok).toBe(false);
    if (!experimental.ok) {
      expect(experimental.error).toContain("tier");
      expect(experimental.error).not.toContain("current provider");
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
    blockAnthropicQuota();
    const result = resolveToolTierOverride(ctxWith(false), "emperor");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Quota fallback is disabled");
      expect(result.error).toContain("anthropic/claude-opus-5");
      expect(result.error).not.toContain("provider/model");
    }
  });

  it("non-feudalism tier validation names only legal concrete routing", () => {
    const disabled = resolveToolTierOverride(
      { ...ctxWith(undefined), orchestrationMode: "disabled" as const },
      "emperor",
    );
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) {
      expect(disabled.error).toContain("active-provider model id");
      expect(disabled.error).not.toContain("provider` + `model");
    }

    const defaultMode = resolveToolTierOverride(
      { ...ctxWith(undefined), orchestrationMode: "default" as const },
      "emperor",
    );
    expect(defaultMode.ok).toBe(false);
    if (!defaultMode.ok) {
      expect(defaultMode.error).toContain("provider` + `model` pins");
      expect(defaultMode.error).not.toContain("active-provider model id");
    }
  });

  it("fallback enabled (default, flag absent): reroutes past the quota-blocked candidate", () => {
    blockAnthropicQuota();
    const result = resolveToolTierOverride(ctxWith(undefined), "emperor");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ctx.provider).toBe("codex");
  });

  it("fallback disabled: missing-credential skips alone do not fail the step", () => {
    // No quota state anywhere: rank 1 (anthropic) is credentialed and usable,
    // so resolution lands on it; uncredentialed providers are not quota skips.
    const result = resolveToolTierOverride(ctxWith(false), "emperor");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ctx.provider).toBe("anthropic");
  });
});

describe("quota fallback gate (mid-run reroute)", () => {
  it("fallback disabled: refuses the reroute", () => {
    const result = resolveToolTierQuotaReroute(ctxWith(false), "emperor", "codex");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Quota fallback is disabled");
      expect(result.error).not.toContain("provider/model");
    }
  });

  it("fallback enabled: reroutes to the next usable candidate", () => {
    const result = resolveToolTierQuotaReroute(ctxWith(true), "emperor", "codex");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ctx.provider).toBe("anthropic");
  });

  it("fallback enabled + no candidate left: failure is NOT gated (default output untouched)", () => {
    setCredentialsLoaderForTests(
      () => ({ codex: { accessToken: "x" } }) as unknown as CredentialsBundle,
    );
    const result = resolveToolTierQuotaReroute(ctxWith(true), "emperor", "codex");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.gated).not.toBe(true);
  });
});

describe("quota fallback gate (verify-panel regressions)", () => {
  it("caller's own tier model quota-blocked by a model-scoped window fails instead of silently rerouting", () => {
    // A window scoped to the caller's exact model: the caller (emperor rank 1) is
    // quota-displaced like any other candidate — no active-provider exemption.
    replaceProviderQuotaObservations("anthropic", [
      {
        scopeKey: "weekly_opus_5",
        displayLabel: "Anthropic Opus limit",
        applicability: { type: "model", id: "claude-opus-5" },
        warning: null,
        routing: {
          trackingStatus: "tracked",
          utilizationPct: 100,
          resetsAtEpochMs: Date.now() + 3_600_000,
          balanceStatus: "unknown",
        },
      },
    ]);
    const ctx = {
      ...ctxWith(false),
      provider: "anthropic",
      model: "claude-opus-5",
    } as RequestContext;
    const result = resolveToolTierOverride(ctx, "emperor");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gated).toBe(true);
      expect(result.error).toContain("anthropic/claude-opus-5");
    }
  });

  it("active provider under transient cooldown + high utilization is a cooldown skip, not a gate failure", () => {
    setRoutingUsage("anthropic", {
      trackingStatus: "tracked",
      utilizationPct: 96,
      resetsAtEpochMs: Date.now() + 3_600_000,
      balanceStatus: "available",
    });
    markProviderCooldown("anthropic", Date.now() + 60_000, "rate_limited", null);
    const ctx = {
      ...ctxWith(false),
      provider: "anthropic",
      model: "claude-opus-5",
    } as RequestContext;
    const result = resolveToolTierOverride(ctx, "emperor");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ctx.provider).toBe("codex");
  });
});

describe("quota fallback gate (workflow bridge)", () => {
  const bridgeOpts = { tier: "emperor", diversify: false } as const;

  it("fallback disabled: workflow tier routing fails when rank 1 is quota-blocked", () => {
    blockAnthropicQuota();
    const result = resolveWorkflowAgentModelContextDetailed(ctxWith(false), bridgeOpts);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Quota fallback is disabled");
    expect(result.error).toContain("anthropic/claude-opus-5");
    expect(result.error).not.toContain("provider/model");
  });

  it("fallback enabled (default): workflow tier routing reroutes past the blocked candidate", () => {
    blockAnthropicQuota();
    const result = resolveWorkflowAgentModelContextDetailed(ctxWith(undefined), bridgeOpts);
    expect(result.ok).toBe(true);
    expect(result.ctx.provider).toBe("codex");
  });

  it("fallback disabled: healthy roster still resolves normally", () => {
    const result = resolveWorkflowAgentModelContextDetailed(ctxWith(false), bridgeOpts);
    expect(result.ok).toBe(true);
    expect(result.ctx.provider).toBe("anthropic");
  });
});

// The gate is asserted through its own helper rather than through `dispatchFork`:
// sibling test files replace `fork/spawn.ts` process-wide (bun's `mock.module` is
// not file-scoped), so a dispatch-level assertion would test whichever module won.
describe("inherited launches", () => {
  it("refuses a launch that would ride an exhausted parent route", () => {
    const ctx = ctxWith(undefined);
    expect(inheritedRouteRefusal(ctx)).toBeNull();

    blockAnthropicQuota();
    expect(inheritedRouteRefusal(ctx)).toContain("QuotaExhaustedError");

    clearRoutingUsage();
    expect(inheritedRouteRefusal(ctx)).toBeNull();
  });

  it("names the routing the caller's orchestration mode actually allows", () => {
    blockAnthropicQuota();

    expect(
      inheritedRouteRefusal({ ...ctxWith(undefined), orchestrationMode: "disabled" }),
    ).toContain("another model from the current provider");
    expect(
      inheritedRouteRefusal({ ...ctxWith(undefined), orchestrationMode: "default" }),
    ).toContain("Pin another provider/model");
    expect(inheritedRouteRefusal(ctxWith(undefined))).toContain("`tier` routing");
  });
});
