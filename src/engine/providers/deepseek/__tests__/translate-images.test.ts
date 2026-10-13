import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelsForProvider } from "@/engine/model/catalog.ts";
import { NON_VISION_IMAGE_PLACEHOLDER } from "@/engine/model/facts/capabilities.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import { translateRequestDeepseek } from "@/engine/providers/deepseek/translate.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

registerAllProviders();

let scratchDir: string;
let priorConfigDir: string | undefined;

beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "deepseek-images-"));
  priorConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  process.env.OTHERSIDE_CONFIG_DIR = scratchDir;
});

afterAll(() => {
  if (priorConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = priorConfigDir;
  rmSync(scratchDir, { recursive: true, force: true });
});

function ctxFor(model: string): RequestContext {
  return {
    provider: "deepseek",
    model,
    effort: "high",
    permissionMode: "default",
    sessionId: "deepseek-images",
    cwd: "/tmp",
  } as unknown as RequestContext;
}

const withImage: Message[] = [
  {
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1n" } },
      { type: "text", text: "what is in this image?" },
    ],
  },
];

function wireBlockTypes(model: string): string[] {
  const body = translateRequestDeepseek(ctxFor(model), withImage, []) as {
    messages: { content: { type: string; text?: string }[] }[];
  };
  return body.messages.flatMap((message) =>
    message.content.map((block) => (block.type === "text" ? `text:${block.text}` : block.type)),
  );
}

describe("deepseek images", () => {
  it("sends images to the Flash models, which read them natively", () => {
    expect(wireBlockTypes("deepseek-flash")).toContain("image");
    expect(wireBlockTypes("deepseek-v4-flash")).toContain("image");
  });

  it("replaces images with a placeholder for V4 Pro", () => {
    const blocks = wireBlockTypes("deepseek-v4-pro");
    expect(blocks).not.toContain("image");
    expect(blocks).toContain(`text:${NON_VISION_IMAGE_PLACEHOLDER}`);
  });
});

describe("deepseek catalog", () => {
  it("offers V4 Pro, V4.1 Flash and V4 Flash with the effort levels the API applies", () => {
    const models = modelsForProvider("deepseek");
    expect(models.map((model) => model.id)).toEqual([
      "deepseek-v4-pro",
      "deepseek-flash",
      "deepseek-v4-flash",
    ]);
    for (const model of models) expect(model.efforts).toEqual(["low", "high", "max"]);
  });
});
