import { afterEach, describe, expect, it } from "bun:test";
import { isLeanPromptForModel } from "@/engine/providers/_shared/prompt-tier.ts";

const saved = process.env.OTHERSIDE_SIMPLE_SYSTEM_PROMPT;

afterEach(() => {
  if (saved === undefined) delete process.env.OTHERSIDE_SIMPLE_SYSTEM_PROMPT;
  else process.env.OTHERSIDE_SIMPLE_SYSTEM_PROMPT = saved;
});

describe("isLeanPromptForModel", () => {
  it("gives Opus 5.5 and Sonnet 5.5 the lean prompt on their own provider", () => {
    delete process.env.OTHERSIDE_SIMPLE_SYSTEM_PROMPT;
    expect(isLeanPromptForModel("anthropic", "claude-opus-5-5")).toBe(true);
    expect(isLeanPromptForModel("anthropic", "claude-opus-5-5[1m]")).toBe(true);
    expect(isLeanPromptForModel("anthropic", "claude-sonnet-5-5")).toBe(true);
    expect(isLeanPromptForModel("antigravity", "claude-opus-5-5")).toBe(false);
  });

  it("keeps the other models on the standard prompt", () => {
    delete process.env.OTHERSIDE_SIMPLE_SYSTEM_PROMPT;
    expect(isLeanPromptForModel("anthropic", "claude-sonnet-5")).toBe(false);
    expect(isLeanPromptForModel("anthropic", "claude-fable-5-1")).toBe(false);
  });

  it("gives an early-access model the lean prompt", () => {
    delete process.env.OTHERSIDE_SIMPLE_SYSTEM_PROMPT;
    expect(isLeanPromptForModel("anthropic", "claude-sonnet-5-eap")).toBe(true);
    expect(isLeanPromptForModel("anthropic", "claude-sonnet-5-eap[1m]")).toBe(true);
  });

  it("lets the environment force either prompt", () => {
    process.env.OTHERSIDE_SIMPLE_SYSTEM_PROMPT = "1";
    expect(isLeanPromptForModel("anthropic", "claude-sonnet-5")).toBe(true);
    process.env.OTHERSIDE_SIMPLE_SYSTEM_PROMPT = "0";
    expect(isLeanPromptForModel("anthropic", "claude-opus-5-5")).toBe(false);
  });

  it("has no prompt without a model", () => {
    process.env.OTHERSIDE_SIMPLE_SYSTEM_PROMPT = "1";
    expect(isLeanPromptForModel("anthropic", undefined)).toBe(false);
  });
});
