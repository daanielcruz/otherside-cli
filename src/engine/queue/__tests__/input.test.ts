import { describe, expect, it } from "bun:test";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import { resolveNonVisionImageBlocks } from "@/engine/queue/turn/input.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";

registerAllProviders();

const imageBlock: ContentBlock = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "SGVsbG8=" },
};

const baseInput = {
  text: "[Image #1]",
  session: { id: "sess-test", cwd: "/tmp" },
  imageParserProvider: undefined,
};

describe("resolveNonVisionImageBlocks", () => {
  it("passes image through unchanged for glm (paste path uses server-side analyze_image)", async () => {
    const blocks = await resolveNonVisionImageBlocks({
      ...baseInput,
      blocks: [{ type: "text", text: "descreva" }, imageBlock],
      turnState: {
        provider: "glm",
        model: "glm-5.2",
        effort: "high",
        permissionMode: "default",
      },
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toBe(imageBlock);
  });

  it("passes image through unchanged for anthropic", async () => {
    const blocks = await resolveNonVisionImageBlocks({
      ...baseInput,
      blocks: [imageBlock],
      turnState: {
        provider: "anthropic",
        model: "claude-3-opus-20240229",
        effort: null,
        permissionMode: "default",
      },
    });
    expect(blocks).toEqual([imageBlock]);
  });

  it("returns blocks unchanged when no image is present", async () => {
    const blocks = await resolveNonVisionImageBlocks({
      ...baseInput,
      blocks: [{ type: "text", text: "hello" }],
      turnState: {
        provider: "glm",
        model: "glm-5.2",
        effort: null,
        permissionMode: "default",
      },
    });
    expect(blocks).toEqual([{ type: "text", text: "hello" }]);
  });
});
