import { describe, expect, it } from "bun:test";
import { resolveProviderError } from "@/engine/providers/_shared/provider-error.ts";
import { ProviderHttpError } from "@/engine/providers/_shared/retry.ts";
import { classifyProviderError } from "@/engine/transport/_infra/classify/classify.ts";
import { classifyError } from "@/engine/transport/_infra/classify/error-classifier.ts";
import {
  assessRequestBody,
  requestTooLargeMessage,
} from "@/engine/transport/_infra/classify/request-size.ts";

const MB = 1024 * 1024;
const TOO_LARGE_BODY =
  '{"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}';

function imageBlock(bytes: number) {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "A".repeat(bytes) },
  };
}

describe("a body refused for its size", () => {
  it("is a request-size failure, not a context-window overflow", () => {
    expect(
      resolveProviderError({ provider: "anthropic", status: 413, body: TOO_LARGE_BODY }),
    ).toMatchObject({ class: "request_too_large", retryable: false });
    expect(resolveProviderError({ provider: "anthropic", body: TOO_LARGE_BODY })).toMatchObject({
      class: "request_too_large",
    });
  });

  it("stays a context overflow when the size refusal names the context window", () => {
    expect(
      resolveProviderError({
        provider: "anthropic",
        status: 413,
        body: '{"error":{"message":"Prompt is too long for the context window"}}',
      }),
    ).toMatchObject({ class: "context_overflow" });
  });

  it("offers compaction, never a larger context window", () => {
    const err = new ProviderHttpError({ provider: "anthropic", status: 413, body: TOO_LARGE_BODY });
    const decision = classifyProviderError(err, { provider: "anthropic" });
    expect(decision).toMatchObject({ kind: "fail", reason: "request_too_large" });
    const meta = classifyError({
      err,
      decision,
      provider: "anthropic",
      model: "claude-opus-5-5",
      attempt: 1,
      source: "stream-retry",
    });
    expect(meta).toMatchObject({ errorClass: "request-too-large", title: "Request too large" });
    expect(meta.actions.map((action) => action.id)).toEqual(["compact", "cancel"]);
  });
});

describe("assessRequestBody", () => {
  it("measures inline media in every wire shape", () => {
    const anthropic = assessRequestBody(
      { messages: [{ content: [{ type: "tool_result", content: [imageBlock(1000)] }] }] },
      "anthropic",
    );
    expect(anthropic.mediaBytes).toBe(1000);
    const gemini = assessRequestBody(
      {
        contents: [{ parts: [{ inlineData: { mimeType: "image/jpeg", data: "B".repeat(500) } }] }],
      },
      "antigravity",
    );
    expect(gemini.mediaBytes).toBe(500);
    const dataUrl = `data:image/png;base64,${"C".repeat(300)}`;
    const openai = assessRequestBody(
      { input: [{ type: "input_image", image_url: dataUrl }] },
      "codex",
    );
    expect(openai.mediaBytes).toBe(dataUrl.length);
  });

  it("says media can be removed when images make up the body", () => {
    const body = { messages: [{ content: Array.from({ length: 40 }, () => imageBlock(MB)) }] };
    const assessment = assessRequestBody(body, "anthropic");
    expect(assessment).toMatchObject({ kind: "strippable_media", limitBytes: 32 * MB });
    const message = requestTooLargeMessage(assessment);
    expect(message).toContain("max 32.0 MB");
    expect(message).toContain("40.0 MB of about 40.0 MB is images or documents");
    expect(message).toContain("Run /compact");
  });

  it("says compaction cannot help when text alone is over the limit", () => {
    const body = { messages: [{ content: [{ type: "text", text: "x".repeat(33 * MB) }] }] };
    const assessment = assessRequestBody(body, "anthropic");
    expect(assessment.kind).toBe("unrecoverable");
    const message = requestTooLargeMessage(assessment);
    expect(message).toContain("compacting cannot make it fit");
    expect(message).not.toContain("Run /compact");
  });

  it("names no limit for a provider that publishes none", () => {
    const assessment = assessRequestBody({ messages: [imageBlock(10)] }, "codex");
    expect(assessment.limitBytes).toBeUndefined();
    expect(requestTooLargeMessage(assessment)).not.toContain("max");
  });
});
