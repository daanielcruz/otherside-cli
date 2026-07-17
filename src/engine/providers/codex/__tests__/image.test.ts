import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import GenerateImageSchema from "@/harness/tools/GenerateImage/tool.json" with { type: "json" };
import { saveFor } from "@/kernel/storage/credentials.ts";
import { generateImage } from "../image.ts";

let configDir: string;
const originalFetch = global.fetch;

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), "codex-image-test-"));
  process.env.OTHERSIDE_CONFIG_DIR = configDir;
  await saveFor("codex", {
    accessToken: "test-access",
    refreshToken: "test-refresh",
    accountId: "test-account",
    expiresAt: Date.now() + 60 * 60_000,
    installationId: "test-installation",
    windowId: "test-window",
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.OTHERSIDE_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
});

describe("Codex Images API", () => {
  it("generates with gpt-image-2 through the direct Images endpoint", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return Promise.resolve(Response.json({ created: 1, data: [{ b64_json: "generated" }] }));
    }) as unknown as typeof fetch;

    const result = await generateImage({ prompt: "paint a moonlit lake" });

    expect(result.base64).toBe("generated");
    expect(result.mediaType).toBe("image/png");
    expect(capturedUrl).toBe("https://chatgpt.com/backend-api/codex/images/generations");
    expect(capturedInit?.method).toBe("POST");
    expect((capturedInit?.headers as Record<string, string>).Accept).toBe("application/json");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      prompt: "paint a moonlit lake",
      background: "auto",
      model: "gpt-image-2",
      quality: "auto",
      size: "1024x1024",
    });
  });

  it("edits referenced images through the direct edits endpoint", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Promise.resolve(Response.json({ created: 1, data: [{ b64_json: "edited" }] }));
    }) as unknown as typeof fetch;

    const result = await generateImage({
      prompt: "make the sky warmer",
      size: "1536x1024",
      images: [
        { data: "cG5n", mediaType: "image/png" },
        { data: "anBlZw==", mediaType: "image/jpeg" },
      ],
    });

    expect(result.base64).toBe("edited");
    expect(result.mediaType).toBe("image/png");
    expect(capturedUrl).toBe("https://chatgpt.com/backend-api/codex/images/edits");
    expect(capturedBody).toEqual({
      prompt: "make the sky warmer",
      background: "auto",
      model: "gpt-image-2",
      quality: "auto",
      size: "1536x1024",
      images: [
        { image_url: "data:image/png;base64,cG5n" },
        { image_url: "data:image/jpeg;base64,anBlZw==" },
      ],
    });
  });

  it("rejects a successful response without image bytes", async () => {
    global.fetch = mock(() =>
      Promise.resolve(Response.json({ created: 1, data: [] })),
    ) as unknown as typeof fetch;

    await expect(generateImage({ prompt: "empty response" })).rejects.toThrow(
      "codex image generations response contained no image",
    );
  });

  it("normalizes aborts while reading the image response", async () => {
    const controller = new AbortController();
    global.fetch = mock(() =>
      Promise.resolve({
        status: 200,
        ok: true,
        headers: new Headers(),
        json: () => {
          controller.abort();
          return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
        },
      } as Response),
    ) as unknown as typeof fetch;

    await expect(
      generateImage({ prompt: "cancelled response", abortSignal: controller.signal }),
    ).rejects.toThrow("image generation aborted");
  });

  it("keeps GenerateImage and exposes standard input properties", () => {
    expect(GenerateImageSchema.name).toBe("GenerateImage");
    expect(GenerateImageSchema.inputSchema.properties.referenced_image_paths.maxItems).toBe(5);
    expect(GenerateImageSchema.inputSchema.properties.num_last_images_to_include.minimum).toBe(1);
    expect(GenerateImageSchema.inputSchema.properties.num_last_images_to_include.maximum).toBe(5);
  });
});
