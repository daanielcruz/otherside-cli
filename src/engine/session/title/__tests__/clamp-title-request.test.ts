import { describe, expect, it } from "bun:test";
import { clampTitleRequest } from "@/engine/session/title/generate.ts";

describe("clampTitleRequest", () => {
  it("preserves a provider-owned request object and its identity", () => {
    class SessionRequest {
      readonly model = "fixture-model";
      readonly max_tokens = 128_000;
    }
    const request = new SessionRequest();
    const bindings = new WeakMap<object, string>([[request, "fixture-session"]]);
    const clamped = clampTitleRequest(request);
    expect(clamped).toBe(request);
    expect(clamped).toBeInstanceOf(SessionRequest);
    expect(bindings.get(clamped as SessionRequest)).toBe("fixture-session");
  });

  it("shapes a plain wire body into a capped, tool-free JSON title request", () => {
    const request = {
      max_tokens: 128_000,
      thinking: { type: "adaptive" },
      tools: [{ name: "Read" }],
    };
    const clamped = clampTitleRequest(request) as Record<string, unknown>;
    expect(clamped).not.toBe(request);
    expect(clamped.max_tokens).toBe(32_000);
    expect(clamped.thinking).toEqual({ type: "disabled" });
    expect(clamped.tools).toEqual([]);
    expect(clamped.output_config).toBeDefined();
    expect(request.max_tokens).toBe(128_000);
  });

  it("asks a model that keeps thinking on at a low effort, leaving thinking to the server", () => {
    const request = { model: "claude-haiku-5-5", max_tokens: 128_000, tools: [{ name: "Read" }] };
    const clamped = clampTitleRequest(request) as Record<string, unknown>;
    expect(clamped.max_tokens).toBe(128_000);
    expect(clamped).not.toHaveProperty("thinking");
    expect(clamped).not.toHaveProperty("temperature");
    expect(clamped.tools).toEqual([]);
    expect(clamped.output_config).toMatchObject({
      effort: "medium",
      format: { type: "json_schema" },
    });
  });
});
