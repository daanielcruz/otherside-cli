import { describe, expect, it } from "bun:test";
import type { ProviderModelRoute } from "@/kernel/std/types/provider-ids.ts";
import {
  ANTHROPIC_MANY_IMAGE_MAX_EDGE,
  ANTHROPIC_MANY_IMAGE_THRESHOLD,
  imageRequestPolicyFor,
} from "../../image-request-policy.ts";

const ROUTE_EXPECTATIONS: Array<{
  route: ProviderModelRoute;
  policy: { maxEdge: number; maxRawBytes: number; maxPixels: number };
}> = [
  {
    route: { provider: "anthropic", model: "claude-sonnet-5" },
    policy: { maxEdge: 1568, maxRawBytes: 512_000, maxPixels: 2_458_624 },
  },
  {
    route: { provider: "anthropic", model: "claude-opus-4-8" },
    policy: { maxEdge: 2048, maxRawBytes: 786_432, maxPixels: 4_194_304 },
  },
  {
    route: { provider: "antigravity", model: "gemini-3.6-flash-high" },
    policy: { maxEdge: 2000, maxRawBytes: 786_432, maxPixels: 4_000_000 },
  },
  {
    route: { provider: "codex", model: "gpt-5.5" },
    policy: { maxEdge: 2048, maxRawBytes: 786_432, maxPixels: 2_560_000 },
  },
  {
    route: { provider: "kimi", model: "k3" },
    policy: { maxEdge: 2000, maxRawBytes: 512_000, maxPixels: 4_000_000 },
  },
  {
    route: { provider: "xai", model: "grok-4.5" },
    policy: { maxEdge: 2000, maxRawBytes: 786_432, maxPixels: 2_400_000 },
  },
];

describe("imageRequestPolicyFor", () => {
  for (const expectation of ROUTE_EXPECTATIONS) {
    it(`resolves ${expectation.route.provider}/${expectation.route.model}`, () => {
      expect(imageRequestPolicyFor(expectation.route)).toEqual(expectation.policy);
    });
  }

  it("keeps the Codex policy for unlisted model IDs", () => {
    expect(imageRequestPolicyFor({ provider: "codex", model: "custom-codex-model" })).toEqual({
      maxEdge: 2048,
      maxRawBytes: 786_432,
      maxPixels: 2_560_000,
    });
  });

  it("uses a conservative policy for uncovered providers and custom routes", () => {
    expect(imageRequestPolicyFor({ provider: "openai", model: "custom-vision" })).toEqual({
      maxEdge: 1568,
      maxRawBytes: 512_000,
      maxPixels: 2_458_624,
    });
  });

  it("clamps Anthropic maxEdge to the many-image cap when the request is over threshold", () => {
    const route = { provider: "anthropic" as const, model: "claude-opus-4-8" };
    const few = imageRequestPolicyFor(route, { imageCount: ANTHROPIC_MANY_IMAGE_THRESHOLD });
    const many = imageRequestPolicyFor(route, { imageCount: ANTHROPIC_MANY_IMAGE_THRESHOLD + 1 });

    expect(few.maxEdge).toBe(2048);
    expect(many.maxEdge).toBe(ANTHROPIC_MANY_IMAGE_MAX_EDGE);
    expect(many.maxRawBytes).toBe(few.maxRawBytes);
    expect(many.maxPixels).toBe(few.maxPixels);
  });

  it("does not clamp Anthropic routes already at or under the many-image edge", () => {
    const route = { provider: "anthropic" as const, model: "claude-sonnet-5" };
    expect(imageRequestPolicyFor(route, { imageCount: 100 }).maxEdge).toBe(1568);
  });

  it("does not apply the Anthropic many-image edge to other providers", () => {
    const route = { provider: "codex" as const, model: "gpt-5.5" };
    expect(imageRequestPolicyFor(route, { imageCount: 100 }).maxEdge).toBe(2048);
  });
});
