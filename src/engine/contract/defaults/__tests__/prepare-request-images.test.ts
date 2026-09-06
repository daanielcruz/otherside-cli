import { describe, expect, it } from "bun:test";
import { PNG } from "pngjs";
import { imageBlock as mcpImageBlock } from "@/kernel/mcp/client/output/blocks.ts";
import type { ContentBlock, Message, ToolResultContentBlock } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { config as anthropicConfig } from "../../../providers/anthropic/config.ts";
import { config as codexConfig } from "../../../providers/codex/config.ts";
import { buildProvider } from "../../build.ts";

function opaquePng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = (offset / 4) % 251;
    png.data[offset + 1] = 91;
    png.data[offset + 2] = 173;
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

function context(provider: RequestContext["provider"], model: string): RequestContext {
  return {
    provider,
    model,
    sessionId: "image-policy-session",
    cwd: "/workspace/project",
    effort: null,
    permissionMode: "default",
  };
}

function directImage(messages: Message[]): Extract<ContentBlock, { type: "image" }> {
  const block = messages[0]?.content.find((candidate) => candidate.type === "image");
  if (!block || block.type !== "image") throw new Error("direct image missing");
  return block;
}

function nestedImage(messages: Message[]): Extract<ToolResultContentBlock, { type: "image" }> {
  const result = messages[0]?.content.find((candidate) => candidate.type === "tool_result");
  if (!result || result.type !== "tool_result" || !Array.isArray(result.content)) {
    throw new Error("tool result missing");
  }
  const block = result.content.find((candidate) => candidate.type === "image");
  if (!block || block.type !== "image") throw new Error("nested image missing");
  return block;
}

const captureAnthropic = buildProvider({
  ...anthropicConfig,
  translateRequest: (_ctx, messages) => messages,
});
const captureCodex = buildProvider({
  ...codexConfig,
  translateRequest: (_ctx, messages) => messages,
});

describe("request image preparation", () => {
  it("prepares direct and tool-result images identically for one route", () => {
    const original = opaquePng(1800, 1500).toString("base64");
    const directMessages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: original },
          },
        ],
      },
    ];
    const toolMessages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "read-image",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: original },
              },
            ],
          },
        ],
      },
    ];

    const route = context("anthropic", "claude-sonnet-5");
    const preparedDirect = captureAnthropic.translateRequest(
      route,
      directMessages,
      [],
    ) as Message[];
    const preparedTool = captureAnthropic.translateRequest(route, toolMessages, []) as Message[];

    expect(directImage(preparedDirect).source).toEqual(nestedImage(preparedTool).source);
    expect(directImage(preparedDirect).dimensions).toEqual(nestedImage(preparedTool).dimensions);
    expect(
      Buffer.from(directImage(preparedDirect).source.data, "base64").length,
    ).toBeLessThanOrEqual(512_000);
    expect(directImage(directMessages).source.data).toBe(original);
    expect(nestedImage(toolMessages).source.data).toBe(original);
  });

  it("reprocesses the preserved original for a different route", () => {
    const original = opaquePng(1800, 1500).toString("base64");
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: original },
          },
        ],
      },
    ];

    const anthropic = captureAnthropic.translateRequest(
      context("anthropic", "claude-sonnet-5"),
      messages,
      [],
    ) as Message[];
    const codex = captureCodex.translateRequest(
      context("codex", "gpt-5.5"),
      messages,
      [],
    ) as Message[];
    const anthropicAgain = captureAnthropic.translateRequest(
      context("anthropic", "claude-sonnet-5"),
      messages,
      [],
    ) as Message[];

    expect(directImage(anthropicAgain)).toBe(directImage(anthropic));
    expect(directImage(anthropic).dimensions?.displayWidth).toBeLessThan(
      directImage(codex).dimensions?.displayWidth ?? 0,
    );
    expect(directImage(anthropic).source.data).not.toBe(directImage(codex).source.data);
    expect(Buffer.from(directImage(anthropic).source.data, "base64").length).toBeLessThanOrEqual(
      512_000,
    );
    expect(Buffer.from(directImage(codex).source.data, "base64").length).toBeLessThanOrEqual(
      786_432,
    );
    expect(directImage(messages).source.data).toBe(original);
  });

  it("does not re-encode an image already inside the active policy", () => {
    const original = opaquePng(20, 20).toString("base64");
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: original },
          },
        ],
      },
    ];
    const prepared = captureAnthropic.translateRequest(
      context("anthropic", "claude-sonnet-5"),
      messages,
      [],
    ) as Message[];

    expect(prepared).toBe(messages);
    expect(directImage(prepared)).toBe(directImage(messages));
  });

  it("leaves media-free messages byte- and shape-equivalent", () => {
    const messages: Message[] = [
      { role: "system", content: [{ type: "text", text: "system" }] },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];
    const prepared = captureAnthropic.translateRequest(
      context("anthropic", "claude-sonnet-5"),
      messages,
      [],
    ) as Message[];

    expect(prepared).toBe(messages);
    expect(JSON.stringify(prepared)).toBe(JSON.stringify(messages));
  });

  it("rejects empty MCP image data before the request boundary", () => {
    expect(mcpImageBlock("", "image/png")).toEqual({
      type: "text",
      text: "[image decode failed: empty image data]",
    });
  });

  it("prepares MCP images at the same request boundary", () => {
    const original = opaquePng(1800, 1500).toString("base64");
    const mcpBlock = mcpImageBlock(original, "image/png");
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "mcp-image",
            content: [mcpBlock],
          },
        ],
      },
    ];

    const prepared = captureAnthropic.translateRequest(
      context("anthropic", "claude-sonnet-5"),
      messages,
      [],
    ) as Message[];

    expect(nestedImage(prepared).dimensions?.displayWidth).toBeLessThanOrEqual(1568);
    expect(nestedImage(prepared).source.data).not.toBe(original);
    expect(Buffer.from(nestedImage(prepared).source.data, "base64").length).toBeLessThanOrEqual(
      512_000,
    );
    expect(nestedImage(messages).source.data).toBe(original);
  });

  it("downscales Anthropic many-image requests to ≤2000px per edge for opus", () => {
    // 2020 is under the few-image opus edge (2048) but over the many-image API cap (2000).
    const oversized = opaquePng(2020, 100).toString("base64");
    const filler = opaquePng(8, 8).toString("base64");
    const fillerBlocks: ContentBlock[] = Array.from({ length: 20 }, () => ({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: filler },
    }));
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: oversized },
          },
          ...fillerBlocks,
        ],
      },
    ];

    const prepared = captureAnthropic.translateRequest(
      context("anthropic", "claude-opus-4-8"),
      messages,
      [],
    ) as Message[];
    const image = directImage(prepared);
    const dims = PNG.sync.read(Buffer.from(image.source.data, "base64"));

    expect(dims.width).toBeLessThanOrEqual(2000);
    expect(dims.height).toBeLessThanOrEqual(2000);
    expect(image.source.data).not.toBe(oversized);
    expect(directImage(messages).source.data).toBe(oversized);
  });

  it("leaves Anthropic many-image payloads intact when already within 2000px", () => {
    const original = opaquePng(40, 30).toString("base64");
    const blocks: ContentBlock[] = Array.from({ length: 21 }, () => ({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: original },
    }));
    const messages: Message[] = [{ role: "user", content: blocks }];

    const prepared = captureAnthropic.translateRequest(
      context("anthropic", "claude-opus-4-8"),
      messages,
      [],
    ) as Message[];

    expect(prepared).toBe(messages);
    expect(directImage(prepared).source.data).toBe(original);
  });

  it("keeps the few-image opus edge so sub-2048 images are not downscaled", () => {
    // Under the few-image edge; would be clamped only when imageCount > 20.
    const original = opaquePng(2020, 100).toString("base64");
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: original },
          },
        ],
      },
    ];

    const prepared = captureAnthropic.translateRequest(
      context("anthropic", "claude-opus-4-8"),
      messages,
      [],
    ) as Message[];

    expect(prepared).toBe(messages);
    expect(directImage(prepared).source.data).toBe(original);
  });

  it("does not apply Anthropic many-image edge selection to Codex", () => {
    const original = opaquePng(2020, 100).toString("base64");
    const filler = opaquePng(8, 8).toString("base64");
    const fillerBlocks: ContentBlock[] = Array.from({ length: 20 }, () => ({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: filler },
    }));
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: original },
          },
          ...fillerBlocks,
        ],
      },
    ];

    const prepared = captureCodex.translateRequest(
      context("codex", "gpt-5.5"),
      messages,
      [],
    ) as Message[];

    expect(prepared).toBe(messages);
    expect(directImage(prepared).source.data).toBe(original);
  });
});
