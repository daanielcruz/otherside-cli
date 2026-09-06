import { beforeAll, describe, expect, it } from "bun:test";
import { listProviderConfigs } from "@/engine/contract/registry.ts";
import { effortLevelsForModel } from "@/engine/model/catalog.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import { effortStatuslineSuffix } from "@/ui/chrome/status/line-input.ts";

beforeAll(() => {
  registerAllProviders();
});

describe("the effort badge", () => {
  it("names the level a reasoning model is running at", () => {
    expect(effortStatuslineSuffix({ provider: "kimi", model: "k3", effort: "max" })).toBe("Max");
    expect(
      effortStatuslineSuffix({ provider: "antigravity", model: "gemini-3.1-pro", effort: "high" }),
    ).toBe("High");
    expect(
      effortStatuslineSuffix({ provider: "anthropic", model: "claude-opus-5", effort: "xhigh" }),
    ).toBe("xHigh");
  });

  it("stays silent for a model with no levels to choose between", () => {
    expect(
      effortStatuslineSuffix({ provider: "kimi", model: "kimi-for-coding", effort: "high" }),
    ).toBeNull();
  });

  it("stays silent when no level is selected", () => {
    expect(effortStatuslineSuffix({ provider: "kimi", model: "k3", effort: null })).toBeNull();
  });

  // The badge follows the catalog rather than a per-provider switch, because a provider
  // can offer a reasoning model beside one with no levels at all. A provider-wide gate
  // therefore has to be wrong for one of the two.
  it("speaks for every model the catalog gives levels to", () => {
    const silent: string[] = [];
    for (const config of listProviderConfigs()) {
      const provider = config.provider as unknown as ProviderId;
      const models = config.legacyModels;
      for (const entry of typeof models === "function" ? models() : (models ?? [])) {
        if (effortLevelsForModel({ provider, model: entry.id }).length === 0) continue;
        const named = effortStatuslineSuffix({ provider, model: entry.id, effort: "high" });
        if (named === null) silent.push(`${provider}/${entry.id}`);
      }
    }
    expect(silent).toEqual([]);
  });
});
