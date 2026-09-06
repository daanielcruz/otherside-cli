import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import * as registry from "@/engine/providers/registry.ts";
import { resolveNonVisionImageBlocks } from "@/engine/queue/turn/input.ts";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";

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

  it("describes xAI images before the agentic turn", async () => {
    const provider = registry.get("xai");
    const savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    const configDir = mkdtempSync(join(tmpdir(), "otherside-xai-vision-test-"));
    let parserModel = "";
    let parserMessages: Message[] = [];
    registry.register({
      ...provider,
      translateRequest: (ctx, messages) => {
        parserModel = ctx.model;
        parserMessages = messages;
        return {};
      },
      startStreamAttempt: () => ({
        events: (async function* () {
          yield { kind: "message_start" } as const;
          yield { kind: "text_delta", text: "The image says READY." } as const;
          yield { kind: "message_stop", stop_reason: "stop" } as const;
        })(),
        abort: () => {},
      }),
    });
    process.env.OTHERSIDE_CONFIG_DIR = configDir;

    try {
      const blocks = await resolveNonVisionImageBlocks({
        ...baseInput,
        blocks: [{ type: "text", text: "read this" }, imageBlock],
        turnState: {
          provider: "xai",
          model: "grok-4.6",
          effort: "high",
          permissionMode: "default",
        },
      });

      expect(parserModel).toBe("grok-4.6");
      expect(parserMessages[1]?.content).toEqual([
        {
          type: "text",
          text: "Describe everything visible in this image in full detail.",
        },
        imageBlock,
      ]);
      expect(blocks).toEqual([
        { type: "text", text: "read this" },
        { type: "text", text: "[Image #1]\nThe image says READY." },
      ]);
    } finally {
      registry.register(provider);
      if (savedConfigDir === undefined) {
        delete process.env.OTHERSIDE_CONFIG_DIR;
      } else {
        process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
      }
      rmSync(configDir, { recursive: true, force: true });
    }
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
