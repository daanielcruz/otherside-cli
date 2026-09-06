import { describe, expect, it } from "bun:test";
import type { ComposedHarness } from "@/harness/composer/injections.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import { composeGlmMessages } from "../compose.ts";

function harness(overrides: Partial<ComposedHarness> = {}): ComposedHarness {
  return {
    layers: [],
    combined: "",
    systemBlocks: [],
    userPrepend: [],
    midSystemPromotion: "off",
    ...overrides,
  };
}

describe("composeGlmMessages", () => {
  it("coalesces many harness fragments into static + dynamic system blocks, not one per fragment", () => {
    const result = composeGlmMessages(
      harness({
        systemBlocks: [
          { text: "base instructions" },
          { text: "tool guidance" },
          { text: "cwd context", phase: "dynamic" },
          { text: "git status", phase: "dynamic" },
        ],
      }),
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    );
    const system = result[0];
    expect(system?.role).toBe("system");
    expect(system?.content).toHaveLength(2);
    expect(system?.content[0]).toMatchObject({
      type: "text",
      text: "base instructions\n\ntool guidance",
      cache_control: { type: "ephemeral" },
    });
    expect(system?.content[1]).toMatchObject({
      type: "text",
      text: "cwd context\n\ngit status",
      cache_control: { type: "ephemeral" },
    });
  });

  it("never emits a ttl or scope on cache_control — GLM's wire only shows bare ephemeral", () => {
    const result = composeGlmMessages(harness({ systemBlocks: [{ text: "base" }] }), [
      {
        role: "user",
        content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
      },
    ]);
    const system = result[0];
    expect(system?.content[0]).toEqual({
      type: "text",
      text: "base",
      cache_control: { type: "ephemeral" },
    });
  });

  it("tags the trailing text block of the last user message with cache_control", () => {
    const result = composeGlmMessages(harness(), [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ]);
    const last = result[result.length - 1];
    expect(last).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "second", cache_control: { type: "ephemeral" } }],
    });
  });

  it("strips any pre-existing cache_control from user messages before re-tagging", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
      },
    ];
    const result = composeGlmMessages(harness(), messages);
    expect(result[0]).toMatchObject({
      content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
    });
  });

  it("inserts midSystemBlocks as a role:system message right after the first user turn", () => {
    const result = composeGlmMessages(harness({ midSystemBlocks: [{ text: "mid reminder" }] }), [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
    ]);
    const midIndex = result.findIndex(
      (m) =>
        m.role === "system" &&
        m.content[0]?.type === "text" &&
        m.content[0].text === "mid reminder",
    );
    expect(midIndex).toBeGreaterThan(0);
    expect(result[midIndex - 1]?.role).toBe("user");
  });

  it("falls back to a single ephemeral-tagged block from harness.combined when systemBlocks is empty", () => {
    const result = composeGlmMessages(harness({ combined: "fallback system text" }), [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(result[0]).toMatchObject({
      role: "system",
      content: [
        { type: "text", text: "fallback system text", cache_control: { type: "ephemeral" } },
      ],
    });
  });
});
