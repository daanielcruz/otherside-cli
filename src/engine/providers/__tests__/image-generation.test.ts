import { describe, expect, it } from "bun:test";
import {
  imageGeneratorLabel,
  resolveImageGeneratorProvider,
} from "@/engine/providers/image-generation.ts";
import { normalizeConfig } from "@/kernel/config/config.ts";

describe("image generator selection", () => {
  it("uses a native generator by default when no selection is configured", () => {
    expect(resolveImageGeneratorProvider(undefined, "codex")).toBe("codex");
    expect(resolveImageGeneratorProvider(undefined, "xai")).toBe("xai");
    expect(resolveImageGeneratorProvider(undefined, "antigravity")).toBe("antigravity");
  });

  it("honors explicit selections for native and non-native turn providers", () => {
    expect(resolveImageGeneratorProvider("codex", "xai")).toBe("codex");
    expect(resolveImageGeneratorProvider("xai", "antigravity")).toBe("xai");
    expect(resolveImageGeneratorProvider("antigravity", "codex")).toBe("antigravity");
    expect(resolveImageGeneratorProvider("xai", "anthropic")).toBe("xai");
    expect(resolveImageGeneratorProvider(undefined, "anthropic")).toBeNull();
    expect(imageGeneratorLabel("codex")).toBe("Codex");
    expect(imageGeneratorLabel("xai")).toBe("Grok");
    expect(imageGeneratorLabel("antigravity")).toBe("Gemini");
  });

  it("turns image generation off for every turn provider", () => {
    expect(resolveImageGeneratorProvider("off", "codex")).toBeNull();
    expect(resolveImageGeneratorProvider("off", "xai")).toBeNull();
    expect(resolveImageGeneratorProvider("off", "anthropic")).toBeNull();
  });

  it("migrates the legacy image toggle and drops invalid selections", () => {
    expect(normalizeConfig({ imageGen: true } as never).imageGenProvider).toBe("codex");
    expect(normalizeConfig({ imageGen: false } as never).imageGenProvider).toBeUndefined();
    expect(
      normalizeConfig({ imageGen: true, imageGenProvider: "xai" } as never).imageGenProvider,
    ).toBe("xai");
    expect(normalizeConfig({ imageGenProvider: "auto" } as never).imageGenProvider).toBeUndefined();
    expect(
      normalizeConfig({ imageGenProvider: "invalid" } as never).imageGenProvider,
    ).toBeUndefined();
    expect(normalizeConfig({ voiceProvider: "anthropic" } as never).voiceProvider).toBe(
      "anthropic",
    );
    expect(normalizeConfig({ voiceProvider: "auto" } as never).voiceProvider).toBeUndefined();
  });
});
