import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { registerRuntimeModel, resetRuntimeModelsForTests } from "@/engine/model/catalog.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import {
  clearRoutingUsage,
  clearUsageLimits,
  setRoutingUsage,
} from "@/engine/session/usage/limits.ts";
import {
  clearProviderCooldowns,
  markProviderCooldown,
} from "@/engine/session/usage/provider-health.ts";
import type { CredentialsBundle } from "@/kernel/storage/credentials.ts";
import { resolveModelPin } from "../facts/model-pin.ts";
import { setCredentialsLoaderForTests } from "../tier/resolver.ts";

registerAllProviders();

const ALL_PROVIDERS = (): CredentialsBundle =>
  ({
    anthropic: { accessToken: "x" },
    codex: { accessToken: "x" },
    antigravity: { accessToken: "x" },
  }) as unknown as CredentialsBundle;

beforeEach(() => {
  clearRoutingUsage();
  clearUsageLimits();
  clearProviderCooldowns();
  setCredentialsLoaderForTests(ALL_PROVIDERS);
});

afterEach(() => {
  setCredentialsLoaderForTests(null);
  clearRoutingUsage();
  clearUsageLimits();
  clearProviderCooldowns();
  resetRuntimeModelsForTests();
});

describe("resolveModelPin", () => {
  it("resolves a model carried by the named provider", () => {
    const result = resolveModelPin("codex", "gpt-5.5");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolution.provider).toBe("codex");
      expect(result.resolution.model).toBe("gpt-5.5");
    }
  });

  it("pins duplicate model ids to the named provider, never a sibling", () => {
    const result = resolveModelPin("antigravity", "gemini-3-flash");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolution.provider).toBe("antigravity");
  });

  it("rejects an unknown provider id", () => {
    const result = resolveModelPin("not-a-provider", "gpt-5.5");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unknown provider "not-a-provider"');
  });

  it("rejects a model the named provider does not carry, hinting at carriers", () => {
    const result = resolveModelPin("anthropic", "gpt-5.5");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('not available on provider "anthropic"');
      expect(result.error).toContain("codex");
    }
  });

  it("rejects a provider without configured credentials, naming the login fix", () => {
    setCredentialsLoaderForTests(
      () => ({ anthropic: { accessToken: "x" } }) as unknown as CredentialsBundle,
    );
    const result = resolveModelPin("codex", "gpt-5.5");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("no configured credentials");
      expect(result.error).toContain("otherside login --provider codex");
    }
  });

  it("reports the real blocked reason when credentials exist but the provider is unavailable", () => {
    markProviderCooldown("codex", Date.now() + 60_000, "rate_limited");
    const result = resolveModelPin("codex", "gpt-5.5");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("temporarily unavailable");
      expect(result.error).toContain("cooldown");
      expect(result.error).not.toContain("no configured credentials");
    }
  });

  it("never blocks a pin predictively below 100% utilization", () => {
    setRoutingUsage("anthropic", {
      trackingStatus: "tracked",
      balanceStatus: "available",
      utilizationPct: 99,
    });
    expect(resolveModelPin("anthropic", "claude-opus-4-8").ok).toBe(true);
    expect(resolveModelPin("anthropic", "claude-opus-4-8", "anthropic").ok).toBe(true);
  });

  it("refuses a pin to an exhausted provider — even the caller's own session provider", () => {
    const resetsAtEpochMs = Date.now() + 3_600_000;
    setRoutingUsage("anthropic", {
      trackingStatus: "tracked",
      balanceStatus: "exhausted",
      utilizationPct: 100,
      resetsAtEpochMs,
    });
    for (const activeProvider of [undefined, "anthropic" as const]) {
      const refused = resolveModelPin("anthropic", "claude-opus-4-8", activeProvider);
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error).toContain("QuotaExhaustedError");
        expect(refused.error).toContain('"anthropic"');
        expect(refused.error).toContain("exhausted its quota/balance");
        expect(refused.error).toContain("resets");
      }
    }
    // Live recovery re-admits the pin immediately — no synthetic cooldown.
    setRoutingUsage("anthropic", {
      trackingStatus: "tracked",
      balanceStatus: "available",
      utilizationPct: 10,
    });
    expect(resolveModelPin("anthropic", "claude-opus-4-8", "anthropic").ok).toBe(true);
  });

  it("resolves a unique family shorthand to its catalog id", () => {
    const result = resolveModelPin("anthropic", "fable-5");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolution.model).toBe("claude-fable-5");
  });

  it("resolves a bare family name with no version to its catalog id", () => {
    const result = resolveModelPin("anthropic", "sonnet");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolution.model).toBe("claude-sonnet-5");
  });

  it("resolves another bare family name with no version to its catalog id", () => {
    const result = resolveModelPin("anthropic", "haiku");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolution.model).toBe("claude-haiku-4-5");
  });

  it("fails a fabricated family name that names more than one model in the provider's catalog", () => {
    registerRuntimeModel({
      id: "codex-widget-alpha",
      displayName: "Widget Alpha",
      contextWindow: 100_000,
      provider: "codex",
      efforts: [],
      defaultEffort: null,
    });
    registerRuntimeModel({
      id: "codex-widget-beta",
      displayName: "Widget Beta",
      contextWindow: 100_000,
      provider: "codex",
      efforts: [],
      defaultEffort: null,
    });
    const result = resolveModelPin("codex", "widget");
    expect(result.ok).toBe(false);
  });

  it("does not take the family path for a base that still carries digits", () => {
    // "fable-4" names no catalog model and isn't a bare family name (it has a
    // digit), so it must fail rather than loosely matching claude-fable-5.
    const result = resolveModelPin("anthropic", "fable-4");
    expect(result.ok).toBe(false);
  });

  it("lists the provider's models when the pin matches nothing anywhere", () => {
    const result = resolveModelPin("anthropic", "not-a-model");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("claude-fable-5");
  });

  it("normalizes a context-window variant to its catalog id", () => {
    const result = resolveModelPin("anthropic", "claude-opus-4-8[1m]");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolution.model).toBe("claude-opus-4-8");
  });
});
