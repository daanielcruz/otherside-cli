import { describe, expect, test } from "bun:test";
import {
  usageFromAnthropic,
  usageFromAnthropicPromptTotal,
  usageFromGemini,
  usageFromOpenAi,
} from "@/engine/providers/_shared/usage.ts";

/**
 * The context total a session displays and compacts against is
 * input + cache_creation + cache_read, so a mapper that leaves a cached prefix
 * inside inputTokens reports the prompt twice on every cache hit.
 */
function contextTotal(event: ReturnType<typeof usageFromAnthropic>): number {
  if (!event || event.kind !== "usage") return 0;
  return (
    (event.inputTokens ?? 0) +
    (event.cacheCreationInputTokens ?? 0) +
    (event.cacheReadInputTokens ?? 0)
  );
}

describe("disjoint prompt counters", () => {
  test("keeps the fresh share the upstream reported", () => {
    const event = usageFromAnthropic({
      input_tokens: 2,
      output_tokens: 40,
      cache_creation_input_tokens: 1022,
      cache_read_input_tokens: 863_576,
    });
    expect(event).toMatchObject({
      kind: "usage",
      inputTokens: 2,
      cacheCreationInputTokens: 1022,
      cacheReadInputTokens: 863_576,
    });
    expect(contextTotal(event)).toBe(864_600);
  });

  test("reads a cache miss as the whole prompt", () => {
    expect(contextTotal(usageFromAnthropic({ input_tokens: 31_285 }))).toBe(31_285);
  });
});

describe("prompt-total counters", () => {
  test("removes the cached share from the reported total", () => {
    const event = usageFromAnthropicPromptTotal({
      input_tokens: 373_671,
      output_tokens: 900,
      cache_read_input_tokens: 372_224,
    });
    expect(event).toMatchObject({
      kind: "usage",
      inputTokens: 1447,
      cacheReadInputTokens: 372_224,
      outputTokens: 900,
    });
    // Without the reduction this total is 745_895 — the prompt counted twice.
    expect(contextTotal(event)).toBe(373_671);
  });

  test("counts creation and read as one cached share", () => {
    const event = usageFromAnthropicPromptTotal({
      input_tokens: 100_000,
      cache_creation_input_tokens: 30_000,
      cache_read_input_tokens: 60_000,
    });
    expect(event).toMatchObject({ inputTokens: 10_000 });
    expect(contextTotal(event)).toBe(100_000);
  });

  test("holds a total the cached counters overshoot at zero", () => {
    const event = usageFromAnthropicPromptTotal({
      input_tokens: 401,
      cache_read_input_tokens: 27_968,
    });
    expect(event).toMatchObject({ inputTokens: 0 });
  });

  test("leaves a total alone when no cache counter is reported", () => {
    expect(usageFromAnthropicPromptTotal({ input_tokens: 375_000 })).toMatchObject({
      inputTokens: 375_000,
    });
  });

  test("reports nothing for a payload carrying no counters", () => {
    expect(usageFromAnthropicPromptTotal({})).toBeNull();
    expect(usageFromAnthropicPromptTotal(null)).toBeNull();
  });
});

describe("the other prompt-total wires agree", () => {
  test("openai reduces by its nested cached counter", () => {
    const event = usageFromOpenAi({
      input_tokens: 315_119,
      output_tokens: 500,
      input_tokens_details: { cached_tokens: 314_112 },
    });
    expect(event).toMatchObject({ inputTokens: 1007, cacheReadInputTokens: 314_112 });
    expect(contextTotal(event)).toBe(315_119);
  });

  test("gemini reduces by its cached content counter", () => {
    const event = usageFromGemini({
      promptTokenCount: 120_000,
      candidatesTokenCount: 300,
      cachedContentTokenCount: 118_000,
    });
    expect(event).toMatchObject({ inputTokens: 2000, cacheReadInputTokens: 118_000 });
    expect(contextTotal(event)).toBe(120_000);
  });
});
