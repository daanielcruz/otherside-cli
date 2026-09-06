import { describe, expect, it } from "bun:test";
import { ProviderHttpError } from "@/engine/providers/_shared/retry.ts";
import { config } from "@/engine/providers/xai/config.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

function ctx(): RequestContext {
  return {
    provider: "xai",
    model: "grok-4.5",
    effort: "high",
    permissionMode: "default",
    sessionId: "xai-rate-limit-budget",
    cwd: "/tmp",
  } as RequestContext;
}

function rateLimitError() {
  return new ProviderHttpError({
    provider: "xai",
    status: 429,
    body: '{"error":{"message":"Too many requests"}}',
  });
}

describe("xAI 429 retry budget", () => {
  it("allows one soft 429 retry then fails on attempt 2", () => {
    const first = config.recoverableError?.(rateLimitError(), ctx(), 1);
    expect(first?.kind).toBe("retry");

    const second = config.recoverableError?.(rateLimitError(), ctx(), 2);
    expect(second).toMatchObject({
      kind: "fail",
      status: 429,
    });
    expect(second && "userMessage" in second ? second.userMessage : "").toMatch(/rate limited/i);
  });
});
