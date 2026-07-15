import { beforeAll, describe, expect, it } from "bun:test";
import { CATALOG, findFamilyMatch, findModel, type ModelEntry } from "@/engine/model/catalog.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";

// Locks the behavior that the `--model <id>` mis-route fix (main.ts) relies on:
// findModel(id) with no provider resolves a model to its owning provider across
// the whole catalog, so a non-active-provider model id routes correctly.
beforeAll(() => registerAllProviders());

describe("model catalog", () => {
  it("defines an auto-compact limit for every built-in model", () => {
    const missing = CATALOG()
      .filter((model) => model.autoCompactTokenLimit === undefined)
      .map((model) => `${model.provider}:${model.id}`);
    expect(missing).toEqual([]);
  });

  it("resolves a non-anthropic model to its provider with no provider arg", () => {
    expect(findModel("minimax-m2.7")?.provider).toBe("minimax");
    expect(findModel("deepseek-v4-pro")?.provider).toBe("deepseek");
  });

  it("resolves the default anthropic model", () => {
    expect(findModel("claude-opus-4-8")?.provider).toBe("anthropic");
  });

  it("returns undefined for an unknown model id", () => {
    expect(findModel("totally-not-a-model-xyz")).toBeUndefined();
  });

  it("resolves a bare family shorthand ('sonnet') scoped to one provider", () => {
    expect(findModel("sonnet", "anthropic")?.id).toBe("claude-sonnet-5");
    expect(findModel("haiku", "anthropic")?.id).toBe("claude-haiku-4-5");
  });

  it("never guesses a provider from a bare family shorthand alone", () => {
    // Unlike a full/base id, a family shorthand only resolves once a
    // provider is named — findModel(id) with no provider must not scan
    // every provider's catalog for it.
    expect(findModel("sonnet")).toBeUndefined();
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
