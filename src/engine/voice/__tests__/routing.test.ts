import { describe, expect, it } from "bun:test";
import { resolveVoiceProvider, voiceProviderLabel } from "@/engine/voice/index.ts";

describe("voice provider routing", () => {
  it("lets an explicit selection override a native current provider", () => {
    expect(resolveVoiceProvider("xai", "anthropic")).toBe("xai");
    expect(resolveVoiceProvider("off", "codex")).toBeNull();
    expect(resolveVoiceProvider(undefined, "anthropic")).toBe("anthropic");
    expect(resolveVoiceProvider(undefined, "codex")).toBe("codex");
  });

  it("uses only explicit selection for non-native providers", () => {
    expect(resolveVoiceProvider(undefined, "deepseek")).toBeNull();
    expect(resolveVoiceProvider("off", "deepseek")).toBeNull();
    expect(resolveVoiceProvider("anthropic", "deepseek")).toBe("anthropic");
    expect(voiceProviderLabel("anthropic")).toBe("Anthropic");
    expect(voiceProviderLabel("xai")).toBe("Grok");
  });
});
