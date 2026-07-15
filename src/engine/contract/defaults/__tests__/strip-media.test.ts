import { describe, expect, it } from "bun:test";
import type { ModelEntry } from "@/engine/model/catalog.ts";
import type { ContentBlock, Message, ToolResultContentBlock } from "@/kernel/std/types/message.ts";
import {
  MAX_MEDIA_ITEMS_PER_REQUEST,
  MAX_MEDIA_ITEMS_PER_REQUEST_1M,
  MEDIA_BYTE_CAP,
  MEDIA_ITEM_STRIP_SLACK,
  MEDIA_REMOVED_PLACEHOLDER,
  mediaItemLimitFor,
  stripExcessMedia,
} from "../strip-media.ts";

function imageBlock(bytes = 10): ContentBlock & ToolResultContentBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "x".repeat(bytes) },
  };
}

function userWithImages(count: number, bytesEach = 10): Message {
  return {
    role: "user",
    content: [
      { type: "text", text: "look" },
      ...Array.from({ length: count }, () => imageBlock(bytesEach)),
    ],
  };
}

function countImages(messages: Message[]): number {
  let n = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "image") n++;
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        for (const nested of block.content) if (nested.type === "image") n++;
      }
    }
  }
  return n;
}

describe("stripExcessMedia", () => {
  it("returns messages untouched under both limits", () => {
    const messages = [userWithImages(3)];
    expect(stripExcessMedia(messages, 100)).toBe(messages);
  });

  it("strips the oldest media first, over-stripping by the slack margin", () => {
    const messages = [userWithImages(2), userWithImages(2), userWithImages(2)];
    const stripped = stripExcessMedia(messages, 5);
    // 6 items, limit 5 → 1 over + 20 slack → all 6 removed (slack floors at zero items left)
    expect(countImages(stripped)).toBe(0);
    expect(stripped[0]?.content.some((b) => b.type === "text")).toBe(true);
  });

  it("keeps the most recent media when the excess exceeds the slack", () => {
    const perMessage = 10;
    const messagesCount = 15; // 150 images
    const limit = 100;
    const messages = Array.from({ length: messagesCount }, () => userWithImages(perMessage));
    const stripped = stripExcessMedia(messages, limit);
    const removed = 150 - limit + MEDIA_ITEM_STRIP_SLACK; // 70
    expect(countImages(stripped)).toBe(150 - removed);
    // Oldest messages lost their images; the newest kept all of theirs.
    expect(stripped[0]?.content.filter((b) => b.type === "image")).toHaveLength(0);
    expect(stripped[messagesCount - 1]?.content.filter((b) => b.type === "image")).toHaveLength(
      perMessage,
    );
  });

  it("replaces a message left with no blocks by the placeholder text", () => {
    const onlyImage: Message = { role: "user", content: [imageBlock()] };
    const stripped = stripExcessMedia([onlyImage, userWithImages(1)], 1);
    expect(stripped[0]?.content).toEqual([{ type: "text", text: MEDIA_REMOVED_PLACEHOLDER }]);
  });

  it("counts and strips media nested inside tool results", () => {
    const toolMsg: Message = {
      role: "tool",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [{ type: "text", text: "shot" }, imageBlock(), imageBlock()],
        },
      ],
    };
    const stripped = stripExcessMedia([toolMsg, userWithImages(1)], 1);
    const result = stripped[0]?.content[0];
    if (result?.type !== "tool_result" || !Array.isArray(result.content)) {
      throw new Error("tool_result shape lost");
    }
    expect(result.content.filter((b) => b.type === "image")).toHaveLength(0);
    expect(result.content.some((b) => b.type === "text")).toBe(true);
  });

  it("within one message, nested tool_result media burns the budget before top-level images", () => {
    const mixed: Message = {
      role: "user",
      content: [
        ...Array.from({ length: 30 }, () => imageBlock()),
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: Array.from({ length: 30 }, () => imageBlock()),
        },
      ],
    };
    // 60 items, limit 39 → remove 41 (21 over + 20 slack): the nested pass
    // burns all 30 first, then top-level loses the remaining 11. The reverse
    // (single in-order pass) would have emptied top-level instead.
    const stripped = stripExcessMedia([mixed], 39);
    const content = stripped[0]?.content ?? [];
    const topLevel = content.filter((b) => b.type === "image");
    const nested = content.find((b) => b.type === "tool_result");
    if (nested?.type !== "tool_result" || !Array.isArray(nested.content)) {
      throw new Error("tool_result shape lost");
    }
    expect(topLevel).toHaveLength(19);
    expect(nested.content.filter((b) => b.type === "image")).toHaveLength(0);
  });

  it("enforces the byte cap even when the item count is under the limit", () => {
    const big = Math.ceil(MEDIA_BYTE_CAP / 2) + 1;
    const messages = [userWithImages(1, big), userWithImages(1, big), userWithImages(1, big)];
    const stripped = stripExcessMedia(messages, 100);
    expect(countImages(stripped)).toBeLessThan(3);
    // Newest survives; oldest goes first.
    expect(stripped[2]?.content.filter((b) => b.type === "image")).toHaveLength(1);
  });
});

describe("mediaItemLimitFor", () => {
  const models = [
    { id: "big", contextWindow: 1_000_000 },
    { id: "small", contextWindow: 200_000 },
  ] as ModelEntry[];

  it("grants the raised allowance to 1M-context models", () => {
    expect(mediaItemLimitFor("big", models)).toBe(MAX_MEDIA_ITEMS_PER_REQUEST_1M);
  });

  it("uses the base allowance for smaller windows and unknown models", () => {
    expect(mediaItemLimitFor("small", models)).toBe(MAX_MEDIA_ITEMS_PER_REQUEST);
    expect(mediaItemLimitFor("missing", models)).toBe(MAX_MEDIA_ITEMS_PER_REQUEST);
  });
});
