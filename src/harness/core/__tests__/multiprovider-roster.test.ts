import { describe, expect, test } from "bun:test";
import type { LayerContext } from "@/harness/composer/injections.ts";
import { envInfoLayer } from "@/harness/core/env-info.ts";
import {
  buildMultiproviderToolSection,
  buildWorkflowMultiproviderToolSection,
  type ResolvedTierRoster,
} from "@/harness/core/tier-guidance.ts";

const FAMILY_LINE = "Models on this provider, by tier";

function ctx(multiproviderEnabled: boolean): LayerContext {
  return {
    model: "claude-opus-4-8",
    modelDisplayName: "Opus 4.8",
    modelTierLines: ["General: Opus 4.8", "Warrior: Sonnet 4.6", "Scout: Haiku 4.5"],
    knowledgeCutoff: "January 2026",
    multiproviderEnabled,
  } as unknown as LayerContext;
}

const ROSTER: ResolvedTierRoster = {
  general: [{ provider: "anthropic", display: "Opus 4.8" }],
  warrior: [
    { provider: "anthropic", display: "Sonnet 4.6" },
    { provider: "codex", display: "GPT-x" },
  ],
  scout: [],
};

describe("multiprovider hides the concrete model roster", () => {
  test("env-info keeps the model-family list when multiprovider is OFF", () => {
    const out = envInfoLayer.render(ctx(false));
    expect(out).toContain(FAMILY_LINE);
    expect(out).toContain("You are powered by the model named Opus 4.8");
  });

  test("env-info withholds the model-family list when multiprovider is ON", () => {
    const out = envInfoLayer.render(ctx(true));
    expect(out).not.toContain(FAMILY_LINE);
    // the identity line still names the current model
    expect(out).toContain("You are powered by the model named Opus 4.8");
  });

  test("tool section withholds concrete roster entries but keeps tier briefs + availability", () => {
    const section = buildMultiproviderToolSection(ROSTER);
    expect(section).not.toContain("(anthropic)");
    expect(section).not.toContain("(codex)");
    expect(section).not.toContain("Resolved tier roster");
    expect(section).toContain("the strategist and commander");
    expect(section).toContain("authenticate more providers");
  });

  test("keeps diversify guidance exclusive to Workflow", () => {
    expect(buildMultiproviderToolSection(ROSTER)).not.toContain("diversify: true");
    expect(buildWorkflowMultiproviderToolSection(ROSTER)).toContain("diversify: true");
  });
});
