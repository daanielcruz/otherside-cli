import { describe, expect, it } from "bun:test";
import type { ContentBlock, Message, MessageUsageSnapshot } from "@/kernel/std/types/message.ts";
import {
  countTokensWithEstimates,
  estimateTokens,
  hasAuthoritativeUsage,
  IMAGE_BLOCK_TOKEN_ESTIMATE,
  sumUsageTokens,
} from "../token-count.ts";

describe("active context snapshots", () => {
  const billing: MessageUsageSnapshot = {
    inputTokens: 150_000,
    outputTokens: 10_000,
    cacheCreationInputTokens: 15_000,
    cacheReadInputTokens: 25_000,
  };
  const assistant: Message = { role: "assistant", content: [{ type: "text", text: "answer" }] };
  const later: Message[] = [
    { role: "user", content: [{ type: "text", text: "x".repeat(40) }] },
    {
      role: "tool",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(30) }],
    },
  ];

  it("prefers the latest snapshot plus estimates for subsequent messages only", () => {
    const usage = { ...billing, contextTokens: 50_000 };
    expect(sumUsageTokens(usage)).toBe(50_000);
    expect(countTokensWithEstimates([{ ...assistant, usage }, ...later], null)).toBe(50_020);
    expect(countTokensWithEstimates([assistant, ...later], usage)).toBe(50_020);
    expect(
      countTokensWithEstimates(
        [
          { ...assistant, usage: { ...billing, contextTokens: 90_000 } },
          ...later,
          { ...assistant, usage },
        ],
        null,
      ),
    ).toBe(50_000);
  });

  it("treats zero context as authoritative rather than falling back to billing or text", () => {
    const usage = { ...billing, contextTokens: 0 };
    expect(hasAuthoritativeUsage([{ ...assistant, usage }], null)).toBe(true);
    expect(countTokensWithEstimates([{ ...assistant, usage }, ...later], null)).toBe(20);
    expect(countTokensWithEstimates([assistant], usage)).toBe(0);
  });

  it("estimates after invalidation instead of trusting prior context or aggregate billing", () => {
    const unknown = { ...billing, contextTokens: null };
    const previous = { ...billing, contextTokens: 50_000 };
    const messages = [
      { ...assistant, usage: previous },
      ...later,
      { ...assistant, usage: unknown },
    ];
    expect(sumUsageTokens(unknown)).toBeNull();
    expect(hasAuthoritativeUsage(messages, previous)).toBe(false);
    expect(countTokensWithEstimates(messages, previous)).toBe(24);
    const beforeCommit = [{ ...assistant, usage: previous }, ...later];
    expect(hasAuthoritativeUsage(beforeCommit, unknown)).toBe(false);
    expect(countTokensWithEstimates(beforeCommit, unknown)).toBe(22);
    expect(countTokensWithEstimates([], unknown)).toBe(0);
  });

  it("retains the existing input/cache/output arithmetic without the field", () => {
    expect(sumUsageTokens(billing)).toBe(200_000);
    expect(countTokensWithEstimates([{ ...assistant, usage: billing }, ...later], null)).toBe(
      200_020,
    );
  });
});

describe("estimateTokens", () => {
  it("counts each image block at the authoritative estimate (was undercounted as 0)", () => {
    const image: ContentBlock = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    };
    expect(estimateTokens([{ content: [image, image] }])).toBe(2 * IMAGE_BLOCK_TOKEN_ESTIMATE);
  });

  it("adds image tokens on top of text chars/4", () => {
    const text: ContentBlock = { type: "text", text: "x".repeat(40) };
    const image: ContentBlock = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    };
    expect(estimateTokens([{ content: [text, image] }])).toBe(10 + IMAGE_BLOCK_TOKEN_ESTIMATE);
  });
});
