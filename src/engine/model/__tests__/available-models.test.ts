import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { availableModelListing } from "@/engine/model/tier/available-models.ts";
import { setCredentialsLoaderForTests } from "@/engine/model/tier/usability.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import {
  clearRoutingUsage,
  clearUsageLimits,
  setRoutingUsage,
  setUsageLimits,
} from "@/engine/session/usage/limits.ts";
import { clearProviderCooldowns } from "@/engine/session/usage/provider-health.ts";
import type { CredentialsBundle } from "@/kernel/storage/credentials.ts";

registerAllProviders();

const codexAndAnthropicCreds = (): CredentialsBundle =>
  ({
    codex: { accessToken: "x" },
    anthropic: { accessToken: "x" },
  }) as unknown as CredentialsBundle;

const glmOnlyCreds = (): CredentialsBundle =>
  ({
    glm: { zcodeJwtToken: "x" },
  }) as unknown as CredentialsBundle;

const anthropicOnlyCreds = (): CredentialsBundle =>
  ({
    anthropic: { accessToken: "x" },
  }) as unknown as CredentialsBundle;

beforeEach(() => {
  clearRoutingUsage();
  clearUsageLimits();
  clearProviderCooldowns();
  setCredentialsLoaderForTests(codexAndAnthropicCreds);
});

afterEach(() => {
  setCredentialsLoaderForTests(null);
  clearRoutingUsage();
  clearUsageLimits();
  clearProviderCooldowns();
});

describe("availableModelListing", () => {
  it("orders providers by strongest model and lists the full catalog per provider", () => {
    const listing = availableModelListing();
    expect(listing.map((row) => row.provider)).toEqual(["anthropic", "codex"]);
    expect(listing.find((row) => row.provider === "codex")?.models.map((m) => m.id)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    expect(listing.find((row) => row.provider === "anthropic")?.models.map((m) => m.id)).toEqual([
      "claude-opus-5",
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
  });

  it("limits Disabled-mode listings to the active provider", () => {
    const listing = availableModelListing("anthropic");
    expect(listing.map((row) => row.provider)).toEqual(["anthropic"]);
    expect(listing.find((row) => row.provider === "anthropic")?.models.length).toBeGreaterThan(0);
  });

  it("includes catalog models that belong to no tier roster", () => {
    const listing = availableModelListing();
    const codexIds = listing.find((row) => row.provider === "codex")?.models.map((m) => m.id);
    // gpt-5.5 is not a tier member; the listing must still surface it.
    expect(codexIds).toContain("gpt-5.5");
  });

  it("dedupes the same base model id across tiers (glm-5-turbo once)", () => {
    setCredentialsLoaderForTests(glmOnlyCreds);
    const listing = availableModelListing();
    const glm = listing.find((row) => row.provider === "glm");
    expect(glm).toBeDefined();
    const turboHits = glm?.models.filter((m) => m.id === "glm-5-turbo") ?? [];
    expect(turboHits).toHaveLength(1);
  });

  it("omits a provider whose tracked quota is fully spent (100%)", () => {
    setRoutingUsage("codex", {
      trackingStatus: "tracked",
      utilizationPct: 100,
      resetsAtEpochMs: Date.now() + 60_000,
      balanceStatus: "unknown",
    });
    const listing = availableModelListing();
    expect(listing.map((row) => row.provider)).not.toContain("codex");
    expect(listing.map((row) => row.provider)).toContain("anthropic");
  });

  it("drops the whole Fable family when the Fable weekly window is exhausted", () => {
    setCredentialsLoaderForTests(anthropicOnlyCreds);
    const futureSeconds = Math.floor(Date.now() / 1000) + 86_400;
    setUsageLimits(
      { seven_day_fable: { utilization: 1, resetsAt: futureSeconds } },
      {
        status: "allowed",
        unifiedRateLimitFallbackAvailable: false,
        isOverageActive: false,
      },
    );
    const listing = availableModelListing();
    const anthropic = listing.find((row) => row.provider === "anthropic");
    expect(anthropic).toBeDefined();
    const ids = anthropic?.models.map((m) => m.id) ?? [];
    expect(ids).not.toContain("claude-fable-5");
    // The weekly Fable window is family-scoped: every Fable model leaves together.
    expect(ids).not.toContain("claude-fable-5-1");
    expect(ids).toContain("claude-opus-4-8");
  });
});
