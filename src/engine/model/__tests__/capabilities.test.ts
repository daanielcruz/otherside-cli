import { describe, expect, it } from "bun:test";
import {
  canAutoRoute,
  isVisionCapable,
  messageHasImage,
  NON_VISION_IMAGE_PLACEHOLDER,
  stripNonVisionImages,
  visionParserModel,
} from "@/engine/model/facts/capabilities.ts";
import type { Message } from "@/kernel/std/types/message.ts";

describe("isVisionCapable", () => {
  it("returns true for vision providers whose active model accepts images", () => {
    expect(isVisionCapable("anthropic")).toBe(true);
    expect(isVisionCapable("anthropic", "claude-opus-4-8")).toBe(true);
    expect(isVisionCapable("antigravity")).toBe(true);
    expect(isVisionCapable("antigravity", "gemini-3-flash")).toBe(true);
    expect(isVisionCapable("codex")).toBe(true);
    expect(isVisionCapable("codex", "gpt-5.5")).toBe(true);
    expect(isVisionCapable("kimi")).toBe(true);
    expect(isVisionCapable("kimi", "k3")).toBe(true);
    expect(isVisionCapable("kimi", "kimi-for-coding")).toBe(true);
    expect(isVisionCapable("kimi", "kimi-for-coding-highspeed")).toBe(true);
    expect(isVisionCapable("glm")).toBe(true);
    expect(isVisionCapable("glm", "glm-5.2")).toBe(true);
  });

  it("returns true for hybrid-kind providers when the parser model is active", () => {
    expect(isVisionCapable("minimax", "minimax-m3")).toBe(true);
    expect(isVisionCapable("xai", "grok-4.6")).toBe(true);
  });

  it("returns false for hybrid-kind providers when model is undefined", () => {
    expect(isVisionCapable("minimax")).toBe(false);
    expect(isVisionCapable("xai")).toBe(false);
  });

  it("returns false for model-scoped providers when the model is not vision-capable", () => {
    expect(isVisionCapable("glm", "glm-5-turbo")).toBe(false);
    expect(isVisionCapable("minimax", "minimax-m2.7")).toBe(false);
    expect(isVisionCapable("xai", "grok-composer-2.5-fast")).toBe(false);
  });

  it("returns false for none-kind providers", () => {
    expect(isVisionCapable("deepseek")).toBe(false);
    expect(isVisionCapable("deepseek", "deepseek-v4-pro")).toBe(false);
    expect(isVisionCapable("openai")).toBe(false);
    expect(isVisionCapable("openai", "anything")).toBe(false);
  });
});

describe("visionParserModel", () => {
  it("returns the parser model id for hybrid providers", () => {
    expect(visionParserModel("minimax")).toBe("minimax-m3");
    expect(visionParserModel("xai")).toBe("grok-4.6");
  });

  it("returns undefined for vision and none providers", () => {
    expect(visionParserModel("anthropic")).toBeUndefined();
    expect(visionParserModel("glm")).toBeUndefined();
    expect(visionParserModel("deepseek")).toBeUndefined();
    expect(visionParserModel("openai")).toBeUndefined();
  });
});

describe("canAutoRoute", () => {
  it("returns true for hybrid providers", () => {
    expect(canAutoRoute("minimax")).toBe(true);
    expect(canAutoRoute("xai")).toBe(true);
  });

  it("returns false for vision and none providers", () => {
    expect(canAutoRoute("anthropic")).toBe(false);
    expect(canAutoRoute("glm")).toBe(false);
    expect(canAutoRoute("deepseek")).toBe(false);
    expect(canAutoRoute("openai")).toBe(false);
    expect(canAutoRoute("kimi")).toBe(false);
  });
});

const imageBlock = {
  type: "image" as const,
  source: {
    type: "base64" as const,
    media_type: "image/png" as const,
    data: "iVBORw0",
  },
};

const textBlock = { type: "text" as const, text: "hello" };

describe("stripNonVisionImages", () => {
  it("replaces image blocks with the placeholder text for non-vision providers", () => {
    const messages: Message[] = [{ role: "user", content: [textBlock, imageBlock] }];
    const result = stripNonVisionImages(messages);
    expect(result[0]!.content).toEqual([
      textBlock,
      { type: "text", text: NON_VISION_IMAGE_PLACEHOLDER },
    ]);
  });

  it("does not modify messages when there are no images", () => {
    const messages: Message[] = [{ role: "user", content: [textBlock] }];
    const result = stripNonVisionImages(messages);
    expect(result).toEqual(messages);
  });

  it("handles image blocks inside tool_result content arrays", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: [
              { type: "text", text: "result" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "abc",
                },
              },
            ],
          },
        ],
      },
    ];
    const result = stripNonVisionImages(messages);
    const block = result[0]!.content[0]!;
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      expect(block.content[1]).toEqual({
        type: "text",
        text: NON_VISION_IMAGE_PLACEHOLDER,
      });
      expect(block.content[0]).toEqual({ type: "text", text: "result" });
    }
  });
});

describe("messageHasImage", () => {
  it("returns true when a message has an image block", () => {
    const message: Message = { role: "user", content: [textBlock, imageBlock] };
    expect(messageHasImage(message)).toBe(true);
  });

  it("returns false when a message has no image block", () => {
    const message: Message = { role: "user", content: [textBlock] };
    expect(messageHasImage(message)).toBe(false);
  });

  it("returns true when an image is nested inside a tool_result", () => {
    const message: Message = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "x" },
            },
          ],
        },
      ],
    };
    expect(messageHasImage(message)).toBe(true);
  });
});
