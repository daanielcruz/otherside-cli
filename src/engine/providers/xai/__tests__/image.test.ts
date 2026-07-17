import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as authModule from "@/engine/providers/xai/auth.ts";

const realAuthModule = { ...authModule };

mock.module("@/engine/providers/xai/auth.ts", () => ({
  ...realAuthModule,
  currentTokens: async () => ({
    accessToken: "xai-access",
    refreshToken: "xai-refresh",
    expiresAt: Date.now() + 60_000,
  }),
}));

import { generateImage } from "../image.ts";

const originalFetch = global.fetch;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("xai image generation", () => {
  beforeEach(() => {
    global.fetch = originalFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  afterAll(() => {
    mock.module("@/engine/providers/xai/auth.ts", () => realAuthModule);
  });

  it("generates an image through the Imagine API", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return Promise.resolve(jsonResponse({ data: [{ b64_json: "generated-jpeg" }] }));
    }) as unknown as typeof fetch;

    const result = await generateImage({ prompt: "paint a moonlit lake", size: "1536x1024" });

    expect(result).toMatchObject({ base64: "generated-jpeg", mediaType: "image/jpeg" });
    expect(capturedUrl).toBe("https://api.x.ai/v1/images/generations");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toMatchObject({
      Authorization: "Bearer xai-access",
      "User-Agent": "xai-grok-build/0.2.91",
      Accept: "application/json",
    });
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      model: "grok-imagine-image-quality",
      prompt: "paint a moonlit lake",
      n: 1,
      resolution: "1k",
      response_format: "b64_json",
      aspect_ratio: "3:2",
    });
  });

  it("edits one reference image with the single-image contract", async () => {
    let body: unknown;
    global.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Promise.resolve(jsonResponse({ data: [{ b64_json: "edited-jpeg" }] }));
    }) as unknown as typeof fetch;

    const result = await generateImage({
      prompt: "make it warmer",
      images: [{ mediaType: "image/png", data: "cG5n" }],
    });

    expect(result.base64).toBe("edited-jpeg");
    expect(body).toEqual({
      model: "grok-imagine-image-quality",
      prompt: "make it warmer",
      n: 1,
      resolution: "1k",
      response_format: "b64_json",
      image: { url: "data:image/png;base64,cG5n" },
    });
  });

  it("edits multiple references with an explicit aspect ratio", async () => {
    let url = "";
    let body: unknown;
    global.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return Promise.resolve(jsonResponse({ data: [{ b64_json: "edited-jpeg" }] }));
    }) as unknown as typeof fetch;

    await generateImage({
      prompt: "combine them",
      size: "1024x1536",
      images: [
        { mediaType: "image/png", data: "one" },
        { mediaType: "image/jpeg", data: "two" },
        { mediaType: "image/webp", data: "three" },
      ],
    });

    expect(url).toBe("https://api.x.ai/v1/images/edits");
    expect(body).toMatchObject({
      aspect_ratio: "2:3",
      images: [
        { url: "data:image/png;base64,one" },
        { url: "data:image/jpeg;base64,two" },
        { url: "data:image/webp;base64,three" },
      ],
    });
  });

  it("rejects more than three references before making a request", async () => {
    let requested = false;
    global.fetch = mock(() => {
      requested = true;
      return Promise.resolve(jsonResponse({ data: [{ b64_json: "unexpected" }] }));
    }) as unknown as typeof fetch;

    await expect(
      generateImage({
        prompt: "combine them",
        images: ["one", "two", "three", "four"].map((data) => ({
          mediaType: "image/png" as const,
          data,
        })),
      }),
    ).rejects.toThrow("Grok image generation supports at most 3 image references");
    expect(requested).toBe(false);
  });

  it("reports missing image data and authentication failures", async () => {
    global.fetch = mock(() =>
      Promise.resolve(jsonResponse({ data: [] })),
    ) as unknown as typeof fetch;
    await expect(generateImage({ prompt: "empty" })).rejects.toThrow(
      "xai image generations response contained no image",
    );

    global.fetch = mock(() =>
      Promise.resolve(new Response("expired", { status: 401 })),
    ) as unknown as typeof fetch;
    await expect(generateImage({ prompt: "expired" })).rejects.toThrow(
      "otherside login --provider xai",
    );
  });

  it("normalizes aborted requests", async () => {
    const controller = new AbortController();
    controller.abort();
    global.fetch = mock(() =>
      Promise.reject(new DOMException("aborted", "AbortError")),
    ) as unknown as typeof fetch;

    await expect(
      generateImage({ prompt: "cancelled", abortSignal: controller.signal }),
    ).rejects.toThrow("image generation aborted");
  });
});
