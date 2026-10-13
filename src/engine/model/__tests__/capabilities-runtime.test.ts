import { describe, expect, it } from "bun:test";
import {
  autoRoutesNonVision,
  canSendNatively,
  parserModelsFor,
  resolveParserModel,
  visionCapableProviderIds,
} from "@/engine/model/facts/capabilities-runtime.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import * as registry from "@/engine/providers/registry.ts";

registerAllProviders();

describe("canSendNatively", () => {
  it("returns true for native image providers whose active model accepts images", () => {
    const anthropicModel = registry.get("anthropic").defaultModelId();
    expect(canSendNatively("anthropic", anthropicModel)).toBe(true);
    expect(canSendNatively("anthropic")).toBe(true);
    expect(canSendNatively("antigravity")).toBe(true);
    expect(canSendNatively("codex")).toBe(true);
    expect(canSendNatively("kimi")).toBe(true);
    expect(canSendNatively("glm", "glm-5.2")).toBe(true);
    expect(canSendNatively("glm", "glm-5-turbo")).toBe(false);
  });

  it("follows the model on a provider where only some models read images", () => {
    expect(canSendNatively("deepseek", "deepseek-flash")).toBe(true);
    expect(canSendNatively("deepseek", "deepseek-v4-pro")).toBe(false);
  });

  it("returns false for none-kind providers regardless of model", () => {
    expect(canSendNatively("openai")).toBe(false);
    expect(canSendNatively("openai", "anything")).toBe(false);
  });

  it("returns false for hybrid parser providers because they do not receive image blocks directly", () => {
    expect(canSendNatively("minimax", "minimax-m3")).toBe(false);
    expect(canSendNatively("minimax", "minimax-m2.7")).toBe(false);
    expect(canSendNatively("xai", "grok-4.6")).toBe(false);
    expect(canSendNatively("xai", "grok-composer-2.5-fast")).toBe(false);
  });
});

describe("resolveParserModel", () => {
  it("returns the hybrid vision parser model when defined", () => {
    expect(resolveParserModel("minimax")).toBe("minimax-m3");
    expect(resolveParserModel("xai")).toBe("grok-4.6");
  });

  it("falls back to the provider default model id for non-hybrid providers", () => {
    const anthropicDefault = registry.get("anthropic").defaultModelId();
    expect(resolveParserModel("anthropic")).toBe(anthropicDefault);
    expect(resolveParserModel("anthropic").length).toBeGreaterThan(0);
  });

  it("skips a default that cannot read images for the provider's vision model", () => {
    expect(registry.get("deepseek").defaultModelId()).toBe("deepseek-v4-pro");
    expect(resolveParserModel("deepseek")).toBe("deepseek-flash");
    expect(parserModelsFor("deepseek")).toEqual(["deepseek-flash", "deepseek-v4-flash"]);
  });
});

describe("autoRoutesNonVision", () => {
  it("returns true for hybrid providers", () => {
    expect(autoRoutesNonVision("minimax")).toBe(true);
    expect(autoRoutesNonVision("xai")).toBe(true);
  });

  it("returns false for vision and none providers", () => {
    expect(autoRoutesNonVision("anthropic")).toBe(false);
    expect(autoRoutesNonVision("glm")).toBe(false);
    expect(autoRoutesNonVision("deepseek")).toBe(false);
  });
});

describe("visionCapableProviderIds", () => {
  it("contains anthropic", () => {
    expect(visionCapableProviderIds()).toContain("anthropic");
  });

  it("does not contain providers that fail canSendNatively", () => {
    const ids = visionCapableProviderIds();
    expect(ids).not.toContain("openai");
    expect(ids).toContain("glm");
    expect(ids).toContain("deepseek");
    expect(ids).not.toContain("minimax");
    expect(ids).not.toContain("xai");
  });
});
