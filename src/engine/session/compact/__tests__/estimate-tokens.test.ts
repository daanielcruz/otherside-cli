import { describe, expect, it } from "bun:test";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
import { estimateTokens, IMAGE_BLOCK_TOKEN_ESTIMATE } from "../token-count.ts";

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
