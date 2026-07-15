import { describe, expect, it } from "bun:test";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
import { buildPostCompactRehydration } from "../compact/rehydration.ts";

function image(id: string): ContentBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: id },
  } as ContentBlock;
}

function imagesIn(blocks: ContentBlock[]): string[] {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image")
    .map((b) => (b.source as { data: string }).data);
}

describe("buildPostCompactRehydration image carry-forward cap", () => {
  it("caps preserved images to the most-recent 5 across compaction", () => {
    const preserved = Array.from({ length: 12 }, (_, i) => image(`img-${i}`));
    const { blocks } = buildPostCompactRehydration("default", preserved);
    const kept = imagesIn(blocks);
    expect(kept).toHaveLength(5);
    // keeps the newest 5 (slice from the tail), drops the oldest 7
    expect(kept).toEqual(["img-7", "img-8", "img-9", "img-10", "img-11"]);
  });

  it("carries all images through when at or below the cap", () => {
    const preserved = [image("a"), image("b"), image("c")];
    const { blocks } = buildPostCompactRehydration("default", preserved);
    expect(imagesIn(blocks)).toEqual(["a", "b", "c"]);
  });

  it("emits no image blocks when none are preserved", () => {
    const { blocks } = buildPostCompactRehydration("default", []);
    expect(imagesIn(blocks)).toHaveLength(0);
  });
});
