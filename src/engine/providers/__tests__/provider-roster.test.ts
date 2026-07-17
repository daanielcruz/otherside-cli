import { describe, expect, it } from "bun:test";
import { PROVIDERS } from "@/engine/providers/bootstrap.ts";

const EXPECTED_PROVIDER_IDS = [
  "anthropic",
  "openai",
  "codex",
  "xai",
  "kimi",
  "glm",
  "deepseek",
  "minimax",
  "antigravity",
] as const;

describe("provider roster", () => {
  it("registers exactly the supported provider ids", () => {
    const ids = PROVIDERS.map((provider) => provider.config.provider.id).sort();
    expect(ids).toEqual([...EXPECTED_PROVIDER_IDS].sort());
    expect(ids).toHaveLength(9);
  });
});
