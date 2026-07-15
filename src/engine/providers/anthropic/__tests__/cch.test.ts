import { describe, expect, test } from "bun:test";
import { applyCchAttestation } from "../cch.ts";

function requestBody(input: { model?: string; maxTokens?: number; metadata?: string }): string {
  return JSON.stringify({
    model: input.model ?? "claude-sonnet-5",
    max_tokens: input.maxTokens ?? 8192,
    metadata: { user_id: input.metadata ?? "fixture-a" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "x-anthropic-billing-header: cc_version=2.1.206.abc; cc_entrypoint=cli; cch=00000;",
          },
        ],
      },
    ],
  });
}

function token(body: string): string {
  return applyCchAttestation(body).match(/cch=([0-9a-f]{5});/)?.[1] ?? "";
}

describe("CCH attestation", () => {
  test("hashes metadata bytes", () => {
    expect(token(requestBody({ metadata: "fixture-a" }))).toBe("b6d0c");
    expect(token(requestBody({ metadata: "fixture-b" }))).toBe("8ed54");
  });

  test("excludes model and max_tokens", () => {
    expect(token(requestBody({ model: "claude-opus-4-8", maxTokens: 64000 }))).toBe("b6d0c");
  });
});
