import { describe, expect, it } from "bun:test";
import { config as anthropic } from "@/engine/providers/anthropic/config.ts";
import { config as deepseek } from "@/engine/providers/deepseek/config.ts";
import { config as glm } from "@/engine/providers/glm/config.ts";
import { config as xai } from "@/engine/providers/xai/config.ts";

describe("streamEmitsKeepalive provider flags", () => {
  it("marks Anthropic, DeepSeek, and GLM as keepalive transports", () => {
    expect(anthropic.streamEmitsKeepalive).toBe(true);
    expect(deepseek.streamEmitsKeepalive).toBe(true);
    expect(glm.streamEmitsKeepalive).toBe(true);
  });

  it("does not claim keepalive for xAI (no transport pings)", () => {
    expect(xai.streamEmitsKeepalive).not.toBe(true);
  });
});
