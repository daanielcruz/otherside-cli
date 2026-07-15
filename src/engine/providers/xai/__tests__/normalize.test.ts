import { describe, expect, test } from "bun:test";
import { normalizeGrokBody } from "@/engine/providers/xai/normalize.ts";

describe("normalizeGrokBody", () => {
  test("translates the aux one-shot glm/anthropic-wire fields to the Responses dialect", () => {
    const auxBody = {
      model: "grok-composer-2.5-fast",
      input: [{ type: "message", role: "user", content: "hi" }],
      store: false,
      stream: true,
      max_tokens: 100,
      thinking: { type: "disabled" },
      temperature: 1,
      tools: [],
      tool_choice: "auto",
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
    };
    const out = normalizeGrokBody(auxBody) as Record<string, unknown>;

    expect(out.max_tokens).toBeUndefined();
    expect(out.max_output_tokens).toBe(100);
    expect(out.thinking).toBeUndefined();
    expect(out.output_config).toBeUndefined();
    expect(out.tools).toBeUndefined();
    expect(out.tool_choice).toBeUndefined();
    expect(out.temperature).toBe(1);
    expect(out.text).toEqual({
      format: {
        type: "json_schema",
        name: "response",
        strict: true,
        schema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          additionalProperties: false,
        },
      },
    });
  });

  test("does not touch a clean main-turn body", () => {
    const mainBody = {
      model: "grok-4.5",
      input: [{ type: "message", role: "user", content: "hi" }],
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { summary: "concise", effort: "high" },
      stream: true,
      tools: [{ type: "function", name: "Read", parameters: {} }],
      tool_choice: "auto",
    };
    expect(normalizeGrokBody(mainBody)).toEqual(mainBody);
  });

  test("keeps an existing max_output_tokens over a stray max_tokens", () => {
    const out = normalizeGrokBody({ max_tokens: 100, max_output_tokens: 50 }) as Record<
      string,
      unknown
    >;
    expect(out.max_tokens).toBeUndefined();
    expect(out.max_output_tokens).toBe(50);
  });
});
