import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as authModule from "@/engine/providers/antigravity/auth.ts";
import * as fingerprintModule from "@/engine/providers/antigravity/fingerprint.ts";
import * as usageModule from "@/engine/providers/antigravity/usage.ts";
import * as configModule from "@/kernel/config/config.ts";

const realAuthModule = { ...authModule };
const realFingerprintModule = { ...fingerprintModule };
const realUsageModule = { ...usageModule };
const realConfigModule = { ...configModule };

mock.module("@/engine/providers/antigravity/auth.ts", () => ({
  ...realAuthModule,
  currentTokens: async () => ({
    accessToken: "google-access",
    refreshToken: "google-refresh",
    expiresAt: Date.now() + 60_000,
  }),
  resolveProjectId: async () => "project-123",
}));

mock.module("@/engine/providers/antigravity/fingerprint.ts", () => ({
  ...realFingerprintModule,
  backendHost: () => "https://daily-cloudcode-pa.googleapis.com",
  generateContentUrl: () => "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
  userAgent: () => "antigravity-test-agent",
}));

mock.module("@/engine/providers/antigravity/usage.ts", () => ({
  ...realUsageModule,
  refreshAntigravityQuotaWarning: async () => {},
}));

mock.module("@/kernel/config/config.ts", () => ({
  ...realConfigModule,
  loadConfig: async () => ({ ...realConfigModule.DEFAULT_CONFIG }),
}));

import { generateImage } from "../image.ts";

const originalFetch = global.fetch;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Gemini image generation", () => {
  beforeEach(() => {
    global.fetch = originalFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  afterAll(() => {
    mock.module("@/engine/providers/antigravity/auth.ts", () => realAuthModule);
    mock.module("@/engine/providers/antigravity/fingerprint.ts", () => realFingerprintModule);
    mock.module("@/engine/providers/antigravity/usage.ts", () => realUsageModule);
    mock.module("@/kernel/config/config.ts", () => realConfigModule);
  });

  it("selects the catalog image model and sends the image_gen envelope", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return Promise.resolve(jsonResponse({ imageGenerationModelIds: ["imagen-model"] }));
      }
      return Promise.resolve(
        jsonResponse({
          response: {
            candidates: [
              { content: { parts: [{ inlineData: { mimeType: "image/png", data: "png-data" } }] } },
            ],
          },
        }),
      );
    }) as unknown as typeof fetch;

    const result = await generateImage({
      prompt: "paint a moonlit lake",
      images: [{ mediaType: "image/jpeg", data: "jpeg-ref" }],
    });

    expect(result).toMatchObject({ base64: "png-data", mediaType: "image/png" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: "Bearer google-access",
      "User-Agent": "antigravity-test-agent",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ project: "project-123" });

    expect(calls[1]?.url).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
    );
    const envelope = JSON.parse(String(calls[1]?.init?.body));
    expect(envelope).toMatchObject({
      project: "project-123",
      model: "imagen-model",
      userAgent: "antigravity",
      requestType: "image_gen",
      enabledCreditTypes: ["GOOGLE_ONE_AI"],
      request: {
        model: "imagen-model",
        contents: [
          {
            role: "user",
            parts: [
              { text: "paint a moonlit lake" },
              { inlineData: { mimeType: "image/jpeg", data: "jpeg-ref" } },
            ],
          },
        ],
      },
    });
    expect(envelope.requestId).toMatch(/^image_gen\//);
  });

  it("rejects more than three references before making a request", async () => {
    global.fetch = mock(() => Promise.resolve(jsonResponse({}))) as unknown as typeof fetch;
    const images = Array.from({ length: 4 }, (_, index) => ({
      mediaType: "image/png" as const,
      data: String(index),
    }));

    await expect(generateImage({ prompt: "combine", images })).rejects.toThrow(
      "supports at most 3 image references",
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fails when the catalog has no image model", async () => {
    global.fetch = mock(() =>
      Promise.resolve(jsonResponse({ imageGenerationModelIds: [] })),
    ) as unknown as typeof fetch;

    await expect(generateImage({ prompt: "missing model" })).rejects.toThrow(
      "no Gemini image generation models are available",
    );
  });

  it("fails when the generation response has no supported media", async () => {
    let calls = 0;
    global.fetch = mock(() => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? jsonResponse({ imageGenerationModelIds: ["imagen-model"] })
          : jsonResponse({
              response: { candidates: [{ content: { parts: [{ text: "none" }] } }] },
            }),
      );
    }) as unknown as typeof fetch;

    await expect(generateImage({ prompt: "missing media" })).rejects.toThrow(
      "response contained no supported image",
    );
  });

  it("normalizes aborted catalog requests", async () => {
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
