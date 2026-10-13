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

import { spyOn } from "bun:test";
import * as transport from "@/engine/transport/http1-socket.ts";
import { generateImage } from "../image.ts";

async function* bodyBytes(text: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(text, "utf8");
}

function jsonReply(value: unknown, status = 200): transport.Http1Response {
  return {
    status,
    headers: new Map([["content-type", "application/json"]]),
    body: bodyBytes(JSON.stringify(value)),
  };
}

describe("Gemini image generation", () => {
  let sendSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    sendSpy?.mockRestore();
  });

  afterEach(() => {
    sendSpy?.mockRestore();
  });

  afterAll(() => {
    mock.module("@/engine/providers/antigravity/auth.ts", () => realAuthModule);
    mock.module("@/engine/providers/antigravity/fingerprint.ts", () => realFingerprintModule);
    mock.module("@/engine/providers/antigravity/usage.ts", () => realUsageModule);
    mock.module("@/kernel/config/config.ts", () => realConfigModule);
  });

  it("selects the catalog image model and sends the image_gen envelope", async () => {
    const calls: Array<{ input: transport.Http1RequestInput; contentLengthAt: number }> = [];
    sendSpy = spyOn(transport, "sendSizedRequest").mockImplementation(
      async (input, contentLengthAt) => {
        calls.push({ input, contentLengthAt });
        if (calls.length === 1) {
          return jsonReply({ imageGenerationModelIds: ["imagen-model"] });
        }
        return jsonReply({
          response: {
            candidates: [
              { content: { parts: [{ inlineData: { mimeType: "image/png", data: "png-data" } }] } },
            ],
          },
        });
      },
    );

    const result = await generateImage({
      prompt: "paint a moonlit lake",
      images: [{ mediaType: "image/jpeg", data: "jpeg-ref" }],
    });

    expect(result).toMatchObject({ base64: "png-data", mediaType: "image/png" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.input.url.toString()).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    );
    expect(calls[0]?.input.method).toBe("POST");
    expect(calls[0]?.contentLengthAt).toBe(1);
    expect(calls[0]?.input.headerLines).toEqual([
      "User-Agent: antigravity-test-agent",
      "Authorization: Bearer google-access",
      "Content-Type: application/json",
      "Accept-Encoding: gzip",
    ]);
    expect(JSON.parse(calls[0]!.input.payload.toString("utf8"))).toEqual({
      project: "project-123",
    });

    expect(calls[1]?.input.url.toString()).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
    );
    const envelope = JSON.parse(calls[1]!.input.payload.toString("utf8"));
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
    sendSpy = spyOn(transport, "sendSizedRequest").mockResolvedValue(jsonReply({}));
    const images = Array.from({ length: 4 }, (_, index) => ({
      mediaType: "image/png" as const,
      data: String(index),
    }));

    await expect(generateImage({ prompt: "combine", images })).rejects.toThrow(
      "supports at most 3 image references",
    );
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("fails when the catalog has no image model", async () => {
    sendSpy = spyOn(transport, "sendSizedRequest").mockResolvedValue(
      jsonReply({ imageGenerationModelIds: [] }),
    );

    await expect(generateImage({ prompt: "missing model" })).rejects.toThrow(
      "no Gemini image generation models are available",
    );
  });

  it("fails when the generation response has no supported media", async () => {
    let calls = 0;
    sendSpy = spyOn(transport, "sendSizedRequest").mockImplementation(async () => {
      calls += 1;
      return calls === 1
        ? jsonReply({ imageGenerationModelIds: ["imagen-model"] })
        : jsonReply({
            response: { candidates: [{ content: { parts: [{ text: "none" }] } }] },
          });
    });

    await expect(generateImage({ prompt: "missing media" })).rejects.toThrow(
      "response contained no supported image",
    );
  });

  it("normalizes aborted catalog requests", async () => {
    const controller = new AbortController();
    controller.abort();
    sendSpy = spyOn(transport, "sendSizedRequest").mockRejectedValue(
      new DOMException("aborted", "AbortError"),
    );

    await expect(
      generateImage({ prompt: "cancelled", abortSignal: controller.signal }),
    ).rejects.toThrow("image generation aborted");
  });
});
