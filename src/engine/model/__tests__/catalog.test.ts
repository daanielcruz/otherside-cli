import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  CATALOG,
  defaultEffortForModel,
  defaultModelForProvider,
  findFamilyMatch,
  findModel,
  findUniqueModel,
  type ModelEntry,
  modelsForProvider,
  registerRuntimeModel,
  resetRuntimeModelsForTests,
} from "@/engine/model/catalog.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import { clearRoutingUsage, clearUsageLimits } from "@/engine/session/usage/limits.ts";
import { providerRouteability } from "@/engine/session/usage/provider-routeability.ts";
import { applyScopedQuotaWarnings } from "@/engine/session/usage/quota-warning.ts";

// CLI model inputs may infer a provider only when the catalog has one owner.
beforeAll(() => registerAllProviders());
afterEach(() => {
  resetRuntimeModelsForTests();
  clearRoutingUsage();
  clearUsageLimits();
});

describe("model catalog", () => {
  it("defines an auto-compact limit for every built-in model", () => {
    const missing = CATALOG()
      .filter((model) => model.autoCompactTokenLimit === undefined)
      .map((model) => `${model.provider}:${model.id}`);
    expect(missing).toEqual([]);
  });

  it("exposes Opus 5 as the default Anthropic model", () => {
    expect(modelsForProvider("anthropic").map((model) => model.id)[0]).toBe("claude-opus-5");
    expect(findModel({ provider: "anthropic", model: "claude-opus-5" })).toMatchObject({
      displayName: "Opus 5",
      contextWindow: 1_000_000,
      autoCompactTokenLimit: 967_000,
      supports1m: true,
      supportsPdf: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
    });
    expect(defaultModelForProvider("anthropic")).toBe("claude-opus-5");
  });

  it("keeps an explicit effort-less default instead of the provider fallback", () => {
    expect(defaultEffortForModel({ provider: "anthropic", model: "claude-haiku-4-5" })).toBeNull();
    expect(defaultEffortForModel({ provider: "anthropic", model: "claude-opus-5" })).toBe("high");
    expect(defaultEffortForModel({ provider: "anthropic", model: "not-in-the-catalog" })).toBe(
      "high",
    );
  });

  it("exposes the Kimi Code roster with K3 as the default", () => {
    expect(modelsForProvider("kimi").map((model) => model.id)).toEqual([
      "k3",
      "kimi-for-coding",
      "kimi-for-coding-highspeed",
    ]);
    expect(findModel({ provider: "kimi", model: "k3" })).toMatchObject({
      displayName: "Kimi K3",
      contextWindow: 1_000_000,
      autoCompactTokenLimit: 967_000,
      efforts: ["high", "max"],
      defaultEffort: "max",
    });
    expect(defaultModelForProvider("kimi")).toBe("k3");
  });

  it("resolves unique CLI model inputs to their provider", () => {
    expect(findUniqueModel("minimax-m2.7")?.provider).toBe("minimax");
    expect(findUniqueModel("deepseek-v4-pro")?.provider).toBe("deepseek");
    expect(findUniqueModel("claude-opus-4-8")?.provider).toBe("anthropic");
  });

  it("rejects an unqualified model owned by multiple providers", () => {
    registerRuntimeModel({
      id: "shared-model",
      displayName: "Shared Anthropic model",
      contextWindow: 100_000,
      provider: "anthropic",
      efforts: [],
      defaultEffort: null,
    });
    registerRuntimeModel({
      id: "shared-model",
      displayName: "Shared Codex model",
      contextWindow: 200_000,
      provider: "codex",
      efforts: [],
      defaultEffort: null,
    });

    expect(findUniqueModel("shared-model")).toBeUndefined();
    expect(findModel({ provider: "anthropic", model: "shared-model" })?.contextWindow).toBe(
      100_000,
    );
    expect(findModel({ provider: "codex", model: "shared-model" })?.contextWindow).toBe(200_000);
  });

  it("returns undefined for an unknown model id", () => {
    expect(findUniqueModel("totally-not-a-model-xyz")).toBeUndefined();
  });

  it("resolves a bare family shorthand inside one provider route", () => {
    expect(findModel({ provider: "anthropic", model: "sonnet" })?.id).toBe("claude-sonnet-5");
    expect(findModel({ provider: "anthropic", model: "haiku" })?.id).toBe("claude-haiku-4-5");
  });

  it("never infers a provider from a bare family shorthand", () => {
    expect(findUniqueModel("sonnet")).toBeUndefined();
  });

  it("resolves display names even while the route is quota-blocked", () => {
    applyScopedQuotaWarnings("anthropic", [
      {
        scopeKey: "session",
        displayLabel: "Session",
        applicability: { type: "global" },
        label: "Session",
        utilization: 100,
        resetsAt: null,
        trackingStatus: "tracked",
      },
    ]);
    expect(providerRouteability("anthropic", undefined, "claude-haiku-4-5").usable).toBe(false);
    // Display resolution never consults quota/availability state.
    expect(findModel({ provider: "anthropic", model: "claude-haiku-4-5" })?.displayName).toBe(
      "Haiku 4.5",
    );
  });
});

describe("findFamilyMatch", () => {
  const build = (id: string): ModelEntry => ({
    id,
    displayName: id,
    contextWindow: 100_000,
    provider: "anthropic",
    efforts: [],
    defaultEffort: null,
  });

  it("resolves a bare family name naming exactly one model", () => {
    const catalog = [build("claude-sonnet-5"), build("claude-haiku-4-5")];
    expect(findFamilyMatch(catalog, "sonnet")?.id).toBe("claude-sonnet-5");
  });

  it("matches a family name sitting mid-id, ahead of a trailing suffix", () => {
    const catalog = [build("claude-opus-4-6-thinking")];
    expect(findFamilyMatch(catalog, "opus")?.id).toBe("claude-opus-4-6-thinking");
  });

  it("fails when two models in the catalog share the family name", () => {
    const catalog = [build("claude-opus-4-8"), build("claude-opus-4-7")];
    expect(findFamilyMatch(catalog, "opus")).toBeUndefined();
  });

  it("never matches when the base still carries a digit", () => {
    // Without the digit guard this would uniquely match via the mid-id check.
    const catalog = [build("claude-opus-4-6-thinking")];
    expect(findFamilyMatch(catalog, "opus-4")).toBeUndefined();
  });

  it("returns undefined for an empty catalog slice", () => {
    expect(findFamilyMatch([], "sonnet")).toBeUndefined();
  });
});
