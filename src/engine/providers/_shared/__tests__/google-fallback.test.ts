import { describe, expect, test } from "bun:test";
import { makeGoogleRecoverableError } from "@/engine/providers/_shared/google-fallback.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

class FakeRateLimit {
  body: string;
  status = 429;
  retryAfter: number | null = null;
  retryAfterHeader: string | null = null;

  constructor(body: string) {
    this.body = body;
  }
}

class FakeHttpError {
  body: string;
  status: number;

  constructor(body: string, status = 500) {
    this.body = body;
    this.status = status;
  }
}

const recoverableError = makeGoogleRecoverableError({
  providerId: "antigravity",
  rateLimitErrorCtor: FakeRateLimit as unknown as new (...args: never[]) => FakeRateLimit,
  httpErrorCtor: FakeHttpError as unknown as new (...args: never[]) => FakeHttpError,
});

function ctx(model = "gemini-3-flash"): RequestContext {
  return {
    provider: "antigravity",
    model,
    sessionId: "session-1",
    effort: "high",
    permissionMode: "default",
    fastMode: false,
    agentic: false,
  } as unknown as RequestContext;
}

function terminalQuotaBody({
  message,
  reason,
  quotaId = "GenerateContentPerDay",
}: {
  message: string;
  reason?: string;
  quotaId?: string;
}): string {
  return JSON.stringify({
    error: {
      status: "RESOURCE_EXHAUSTED",
      message,
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [{ quotaId }],
          ...(reason ? { reason } : {}),
        },
      ],
    },
  });
}

describe("makeGoogleRecoverableError", () => {
  test("surfaces the terminal quota message without the /model hint", () => {
    const decision = recoverableError(
      new FakeRateLimit(terminalQuotaBody({ message: "Daily quota exceeded" })),
      ctx(),
    ) as Record<string, unknown>;

    expect(decision.kind).toBe("fail");
    expect(decision.reason).toBe("quota_exhausted");
    expect(decision.quotaExhausted).toBe(true);
    expect(decision.quotaResetEpochMs).toBeNull();
    expect(decision.userMessage).toContain("Daily quota exceeded");
    expect(decision.userMessage).not.toContain("switch to another");
  });

  test("uses the quota reason when the message is empty", () => {
    const decision = recoverableError(
      new FakeRateLimit(
        terminalQuotaBody({
          message: "",
          reason: "GENERATIVE_MODEL_NOT_FOUND",
        }),
      ),
      ctx(),
    ) as Record<string, unknown>;

    expect(decision.kind).toBe("fail");
    expect(String(decision.userMessage)).toContain("GENERATIVE_MODEL_NOT_FOUND");
  });

  test("falls back to the raw body snippet when message and reason are missing", () => {
    const decision = recoverableError(
      new FakeRateLimit(
        terminalQuotaBody({
          message: "",
          quotaId: "GenerateContentPerDay",
        }),
      ),
      ctx(),
    ) as Record<string, unknown>;

    expect(decision.kind).toBe("fail");
    expect(decision.reason).toBe("quota_exhausted");
    expect(String(decision.userMessage)).toContain("GenerateContentPerDay");
    expect(String(decision.userMessage).slice("gemini-3-flash: ".length)).not.toHaveLength(0);
  });
});
