import { describe, expect, it } from "bun:test";
import type { LayerContext } from "@/harness/composer/injections.ts";
import { availableModelsLayer } from "@/harness/core/available-models-guidance.ts";
import { multiproviderGuidanceLayer } from "@/harness/core/session-guidance.ts";

const DEFAULT_GUIDANCE =
  "Multi-provider orchestration is active in Default mode. Choose concrete provider/model pairs from # Available models for delegated Agent and Workflow calls; omit overrides to inherit the current route. Explicit pins are literal: if unavailable, report the failure instead of substituting another route.";

function context(orchestrationMode: "disabled" | "default" | "feudalism"): LayerContext {
  return {
    orchestrationMode,
    availableModels: [
      {
        provider: "anthropic",
        models: [{ id: "claude-opus-4-8", display: "Opus 4.8" }],
      },
      {
        provider: "codex",
        models: [{ id: "gpt-5.5", display: "GPT-5.5" }],
      },
    ],
  } as unknown as LayerContext;
}

describe("orchestration prompt assembly boundaries", () => {
  it("uses exact Default guidance with the all-provider catalog", () => {
    const ctx = context("default");
    expect(multiproviderGuidanceLayer.render(ctx)).toContain(DEFAULT_GUIDANCE);
    const available = availableModelsLayer.render(ctx);
    expect(available).toContain("# Available models");
    expect(available).toContain("## anthropic");
    expect(available).toContain("## codex");
  });

  it("uses only the current-provider catalog in Disabled mode", () => {
    const ctx = context("disabled");
    expect(multiproviderGuidanceLayer.render(ctx)).toBeNull();
    const available = availableModelsLayer.render({
      ...ctx,
      availableModels: [ctx.availableModels[0]!],
    });
    expect(available).toContain("# Available models");
    expect(available).toContain("model` override");
    expect(available).not.toContain("provider` + `model");
    expect(available).not.toContain("tier");
  });

  it("uses tier doctrine only in feudalism and suppresses the catalog", () => {
    const ctx = context("feudalism");
    const guidance = multiproviderGuidanceLayer.render(ctx);
    expect(guidance).toContain("emperor");
    expect(guidance).toContain("daimyo");
    expect(guidance).toContain("samurai");
    expect(availableModelsLayer.render(ctx)).toBeNull();
  });
});
