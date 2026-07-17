import { describe, expect, test } from "bun:test";
import type { LayerContext } from "@/harness/composer/injections.ts";
import { envInfoLayer } from "@/harness/core/env-info.ts";
import {
  buildMultiproviderToolSection,
  buildWorkflowMultiproviderToolSection,
  type ResolvedTierRoster,
} from "@/harness/core/tier-guidance.ts";

function ctx(orchestrationMode: "disabled" | "feudalism"): LayerContext {
  return {
    model: "claude-opus-4-8",
    modelDisplayName: "Opus 4.8",
    knowledgeCutoff: "January 2026",
    orchestrationMode,
  } as unknown as LayerContext;
}

const ROSTER: ResolvedTierRoster = {
  emperor: [{ provider: "anthropic", display: "Opus 4.8" }],
  shogun: [{ provider: "xai", display: "Grok-x" }],
  daimyo: [
    { provider: "anthropic", display: "Sonnet 4.6" },
    { provider: "codex", display: "GPT-x" },
  ],
  samurai: [],
};

describe("orchestration prompt boundaries", () => {
  test("env-info withholds tier doctrine in Disabled mode", () => {
    const out = envInfoLayer.render(ctx("disabled"));
    expect(out).not.toContain("Models on this provider, by tier");
    expect(out).toContain("You are powered by the model named Opus 4.8");
  });

  test("env-info withholds concrete model-family guidance in feudalism", () => {
    const out = envInfoLayer.render(ctx("feudalism"));
    expect(out).not.toContain("Models on this provider, by tier");
    expect(out).toContain("You are powered by the model named Opus 4.8");
  });

  test("tool section withholds concrete roster entries but keeps tier briefs + availability", () => {
    const section = buildMultiproviderToolSection(ROSTER);
    expect(section).not.toContain("(anthropic)");
    expect(section).not.toContain("(codex)");
    expect(section).not.toContain("Resolved tier roster");
    expect(section).toContain("the highest reasoning rank");
    expect(section).toContain("authenticate more providers");
  });

  test("keeps diversify guidance exclusive to Workflow", () => {
    expect(buildMultiproviderToolSection(ROSTER)).not.toContain("diversify: true");
    expect(buildWorkflowMultiproviderToolSection(ROSTER)).toContain("diversify: true");
  });
});
