import { describe, expect, it } from "bun:test";
import {
  autoRoutesNonVision,
  canSendNatively,
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
    expect(canSendNatively("kimi-code")).toBe(true);
    expect(canSendNatively("glm", "glm-5.2")).toBe(true);
    expect(canSendNatively("glm", "glm-5-turbo")).toBe(false);
  });

  it("returns false for none-kind providers regardless of model", () => {
    expect(canSendNatively("deepseek")).toBe(false);
    expect(canSendNatively("deepseek", "deepseek-v4-pro")).toBe(false);
    expect(canSendNatively("openai-custom")).toBe(false);
    expect(canSendNatively("openai-custom", "anything")).toBe(false);
  });

  it("returns false for hybrid parser providers because they do not receive image blocks directly", () => {
    expect(canSendNatively("minimax", "minimax-m3")).toBe(false);
    expect(canSendNatively("minimax", "minimax-m2.7")).toBe(false);
  });
});

describe("resolveParserModel", () => {
  it("returns the hybrid vision parser model when defined", () => {
    expect(resolveParserModel("minimax")).toBe("minimax-m3");
  });

  it("falls back to the provider default model id for non-hybrid providers", () => {
    const anthropicDefault = registry.get("anthropic").defaultModelId();
    expect(resolveParserModel("anthropic")).toBe(anthropicDefault);
    expect(resolveParserModel("anthropic").length).toBeGreaterThan(0);
  });

  it("falls back to the provider default model id for deepseek", () => {
    const deepseekDefault = registry.get("deepseek").defaultModelId();
    expect(resolveParserModel("deepseek")).toBe(deepseekDefault);
  });
});

describe("autoRoutesNonVision", () => {
  it("returns true for hybrid providers", () => {
    expect(autoRoutesNonVision("minimax")).toBe(true);
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
    expect(ids).not.toContain("deepseek");
    expect(ids).not.toContain("openai-custom");
    expect(ids).toContain("glm");
    expect(ids).not.toContain("minimax");
  });
});
