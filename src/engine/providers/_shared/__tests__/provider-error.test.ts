import { describe, expect, it } from "bun:test";
import {
  formatProviderError,
  parseRetryAfterHeader,
  resolveProviderError,
} from "@/engine/providers/_shared/provider-error.ts";
import { getRetryDelay, ProviderHttpError } from "@/engine/providers/_shared/retry.ts";
import { classifyProviderError } from "@/engine/transport/_infra/classify/classify.ts";

const GLM_CONCURRENT_LIMIT =
  '{"type":"error","error":{"type":"rate_limit_error","code":"1302","message":"[1302][Rate limit reached for requests]"}}';

describe("provider error classification", () => {
  it("classifies Anthropic overload envelopes and retry headers", () => {
    const result = resolveProviderError({
      provider: "anthropic",
      model: "claude-fable-5",
      status: 529,
      body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      headers: { "retry-after": "1.5" },
    });

    expect(result).toMatchObject({
      class: "overloaded",
      retryable: true,
      retryAfterMs: 1500,
      provider: "anthropic",
      model: "claude-fable-5",
      detail: "Overloaded",
    });
  });

  it("classifies Codex usage limits as terminal quota", () => {
    const before = Date.now();
    const result = resolveProviderError({
      provider: "codex",
      status: 429,
      body: '{"error":{"type":"usage_limit_reached","message":"You have reached your usage limit","resets_in_seconds":3600}}',
    });

    expect(result.class).toBe("quota_exhausted");
    expect(result.retryable).toBe(false);
    expect(result.quotaResetEpochMs).toBeGreaterThanOrEqual(before + 3_599_000);
  });

  it("classifies xAI string error payloads as invalid requests", () => {
    const result = resolveProviderError({
      provider: "xai",
      body: '{"code":"invalid-argument","error":"Encrypted content could not be verified"}',
    });

    expect(result).toMatchObject({
      class: "invalid_request",
      retryable: false,
      status: 400,
      detail: "Encrypted content could not be verified",
    });
  });

  it("classifies Gemini short resource windows as retryable rate limits", () => {
    const result = resolveProviderError({
      provider: "gemini",
      status: 429,
      body: JSON.stringify({
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "Per-minute capacity reached",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.QuotaFailure",
              violations: [{ quotaId: "GenerateRequestsPerMinute" }],
            },
            { retryDelay: "1.25s" },
          ],
        },
      }),
    });

    expect(result).toMatchObject({
      class: "rate_limit",
      retryable: true,
      retryAfterMs: 1250,
    });
  });

  it("keeps the captured GLM concurrent rejection retryable", () => {
    const result = resolveProviderError({
      provider: "glm",
      status: 429,
      body: GLM_CONCURRENT_LIMIT,
      headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "x-should-retry": "true",
        "retry-after": "38",
      },
    });

    expect(result).toMatchObject({
      class: "rate_limit",
      retryable: true,
      retryAfterMs: 38_000,
    });
  });

  it("classifies DeepSeek HTTP 503 as overloaded", () => {
    const result = resolveProviderError({
      provider: "deepseek",
      status: 503,
      body: '{"error":{"message":"Service temporarily unavailable"}}',
    });

    expect(result).toMatchObject({ class: "overloaded", retryable: true });
  });

  it("classifies Kimi HTTP server failures", () => {
    const result = resolveProviderError({
      provider: "kimi",
      status: 503,
      body: '{"error":{"message":"Service temporarily unavailable"}}',
    });

    expect(result).toMatchObject({ class: "server", retryable: true });
  });

  it("classifies MiniMax concurrency code 2062 as retryable", () => {
    const result = resolveProviderError({
      provider: "minimax",
      status: 429,
      body: '{"error":{"message":"Too many requests","code":"2062"}}',
    });

    expect(result).toMatchObject({ class: "rate_limit", retryable: true });
  });

  it("classifies OpenAI-compatible context failures", () => {
    const result = resolveProviderError({
      provider: "openai",
      body: '{"error":{"code":"context_length_exceeded","message":"Maximum context length exceeded"}}',
    });

    expect(result).toMatchObject({ class: "context_overflow", retryable: false, status: 400 });
  });

  it("formats one concise retry exhaustion cause", () => {
    const text = formatProviderError(
      {
        class: "overloaded",
        retryable: true,
        provider: "anthropic",
        model: "claude-fable-5",
        detail: "Overloaded",
      },
      { retries: 4, elapsedMs: 31_000 },
    );

    expect(text).toBe("overloaded (anthropic/claude-fable-5): overloaded — 4 retries over 31s");
  });

  it("does not retry authentication or certificate failures", () => {
    expect(resolveProviderError({ provider: "anthropic", status: 401 }).retryable).toBe(false);
    const certificateError = Object.assign(new Error("certificate has expired"), {
      code: "CERT_HAS_EXPIRED",
    });
    expect(resolveProviderError({ provider: "xai", error: certificateError })).toMatchObject({
      class: "network",
      retryable: false,
    });
  });
});

describe("provider code tables", () => {
  // Documented Z.AI envelope with a deliberately thin message. The local contract is that
  // business codes remain authoritative when intermediaries omit the descriptive text.
  it.each([
    ["1302", "rate_limit"],
    ["1303", "rate_limit"],
    ["1305", "overloaded"],
    ["1312", "rate_limit"],
  ] as const)("keeps GLM business code %s retryable", (code, errorClass) => {
    expect(
      resolveProviderError({
        provider: "glm",
        status: 429,
        body: JSON.stringify({ error: { code, message: "Request rejected" } }),
      }),
    ).toMatchObject({ class: errorClass, retryable: true });
  });

  it.each([
    "1113",
    "1304",
    "1308",
    "1309",
    "1310",
    "1311",
    "1313",
    "1316",
    "1317",
    "1318",
    "1319",
    "1320",
    "1321",
  ])("makes GLM terminal business code %s quota exhaustion", (code) => {
    expect(
      resolveProviderError({
        provider: "glm",
        status: 429,
        body: JSON.stringify({ error: { code, message: "Request rejected" } }),
      }),
    ).toMatchObject({ class: "quota_exhausted", retryable: false });
  });

  // Documented base_resp codes. The 1008 + HTTP 429 combination is a local contract because
  // MiniMax does not publish HTTP associations for the native status table.
  it.each([
    [1000, "server", true],
    [1001, "server", true],
    [1002, "rate_limit", true],
    [1008, "quota_exhausted", false],
    [1024, "server", true],
    [1026, "invalid_request", false],
    [1027, "invalid_request", false],
    [1033, "server", true],
    [1039, "context_overflow", false],
    [1041, "rate_limit", true],
    [2045, "rate_limit", true],
    [2056, "quota_exhausted", false],
  ] as const)("maps MiniMax base_resp status %i", (statusCode, errorClass, retryable) => {
    const result = resolveProviderError({
      provider: "minimax",
      ...(statusCode === 1008 ? { status: 429 } : {}),
      body: JSON.stringify({ base_resp: { status_code: statusCode, status_msg: "" } }),
    });
    expect(result).toMatchObject({ class: errorClass, retryable });
    if (statusCode === 1026 || statusCode === 1027) {
      expect(result.detail).toContain("content filtered");
    }
  });
});

describe("provider wire fixtures", () => {
  it.each([
    ["billing_error", "quota_exhausted", false],
    ["not_found_error", "invalid_request", false],
    ["timeout_error", "server", true],
  ] as const)("maps Anthropic %s", (type, errorClass, retryable) => {
    const message = type === "not_found_error" ? "model: fixture-model was not found" : type;
    expect(
      resolveProviderError({
        provider: "anthropic",
        body: JSON.stringify({ type: "error", error: { type, message } }),
      }),
    ).toMatchObject({ class: errorClass, retryable, detail: message });
  });

  it("uses Antigravity ErrorInfo reasons, RetryInfo duration, and uiMessage", () => {
    const result = resolveProviderError({
      provider: "antigravity",
      status: 429,
      body: JSON.stringify({
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "Raw quota message",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "QUOTA_EXCEEDED",
              metadata: { uiMessage: "Model allowance used" },
            },
            {
              "@type": "type.googleapis.com/google.rpc.RetryInfo",
              retry_delay: "500ms",
            },
          ],
        },
      }),
    });
    expect(result).toMatchObject({
      class: "quota_exhausted",
      retryable: false,
      retryAfterMs: 500,
      detail: expect.stringContaining("Model allowance used"),
    });
    expect(
      resolveProviderError({
        provider: "antigravity",
        body: '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"1.5m"}]}}',
      }).retryAfterMs,
    ).toBe(90_000);
  });

  it.each([
    ["MODEL_CAPACITY_EXHAUSTED", "overloaded"],
    ["PREFILL_QUEUE_OVERLOADED", "overloaded"],
    ["VERIFICATION_REQUIRED", "auth"],
  ] as const)("maps Antigravity reason %s", (reason, errorClass) => {
    expect(
      resolveProviderError({
        provider: "antigravity",
        body: JSON.stringify({
          error: {
            message: reason === "VERIFICATION_REQUIRED" ? "Verify this account" : "High traffic",
            details: [{ reason }],
          },
        }),
      }),
    ).toMatchObject({ class: errorClass, retryable: errorClass === "overloaded" });
  });

  it("maps bare Antigravity UNAVAILABLE and preemption text as retryable", () => {
    expect(
      resolveProviderError({
        provider: "antigravity",
        body: '{"error":{"status":"UNAVAILABLE","message":"Unavailable"}}',
      }),
    ).toMatchObject({ class: "server", retryable: true });
    expect(
      resolveProviderError({
        provider: "antigravity",
        body: '{"error":{"message":"Request was preempted during decode"}}',
      }),
    ).toMatchObject({ class: "overloaded", retryable: true });
  });

  it.each([
    "server_is_overloaded",
    "slow_down",
  ])("keeps Codex capacity code %s terminal", (code) => {
    expect(
      resolveProviderError({
        provider: "codex",
        status: 503,
        body: JSON.stringify({ error: { code, message: "Capacity unavailable" } }),
      }),
    ).toMatchObject({ class: "overloaded", retryable: false });
  });

  it.each([
    ["Try again in 2 s", 2_000],
    ["Try again in 750ms", 750],
  ] as const)("parses Codex message delay from %s", (message, retryAfterMs) => {
    expect(
      resolveProviderError({
        provider: "codex",
        body: JSON.stringify({ error: { type: "rate_limit_exceeded", message } }),
      }),
    ).toMatchObject({ class: "rate_limit", retryable: true, retryAfterMs });
  });

  it("maps Codex cyber_policy and usage metadata", () => {
    expect(
      resolveProviderError({
        provider: "codex",
        body: '{"type":"response.failed","response":{"error":{"code":"cyber_policy","message":"Request blocked"}}}',
      }),
    ).toMatchObject({ class: "invalid_request", retryable: false });

    const result = resolveProviderError({
      provider: "codex",
      status: 429,
      headers: {
        "x-codex-active-limit": "primary",
        "x-codex-rate-limit-reached-type": "weekly",
        "x-codex-promo-message": "Upgrade for more usage",
      },
      body: '{"error":{"type":"usage_limit_reached","message":"Usage limit reached","resets_at":1893456000}}',
    });
    expect(result).toMatchObject({ class: "quota_exhausted", retryable: false });
    expect(result.quotaResetEpochMs).toBe(1_893_456_000_000);
    expect(result.detail).toContain("active limit: primary");
    expect(result.detail).toContain("limit type: weekly");
    expect(result.detail).toContain("Upgrade for more usage");
    expect(result.detail).toContain("resets at 2030-01-01T00:00:00.000Z");
  });

  // Documented OpenAI-style envelopes; the coding endpoint's accepted envelope is a local contract.
  it("keeps Kimi quota terminal and token-sized invalid requests out of auth", () => {
    expect(
      resolveProviderError({
        provider: "kimi",
        status: 429,
        body: '{"error":{"type":"exceeded_current_quota_error","message":"Current quota exceeded"}}',
      }),
    ).toMatchObject({ class: "quota_exhausted", retryable: false });
    expect(
      resolveProviderError({
        provider: "kimi",
        status: 400,
        body: '{"error":{"type":"invalid_request_error","message":"Input token length too long"}}',
      }),
    ).toMatchObject({ class: "context_overflow", retryable: false });
    expect(
      resolveProviderError({
        provider: "kimi",
        status: 400,
        body: '{"error":{"type":"invalid_request_error","message":"prompt tokens + max_tokens exceeds context limit"}}',
      }),
    ).toMatchObject({ class: "context_overflow", retryable: false });
  });

  it("maps DeepSeek balance and overload statuses", () => {
    expect(
      resolveProviderError({
        provider: "deepseek",
        status: 402,
        body: '{"error":{"message":"Insufficient Balance","type":"unknown_error"}}',
      }),
    ).toMatchObject({ class: "quota_exhausted", retryable: false });
    expect(
      resolveProviderError({
        provider: "deepseek",
        body: '{"error":{"message":"Insufficient Balance","type":"unknown_error"}}',
      }),
    ).toMatchObject({ class: "quota_exhausted", retryable: false });
    expect(resolveProviderError({ provider: "deepseek", status: 503 })).toMatchObject({
      class: "overloaded",
      retryable: true,
    });
  });

  it("keeps xAI policy terminal and status-less service errors retryable", () => {
    expect(
      resolveProviderError({
        provider: "xai",
        status: 403,
        body: '{"error":{"message":"Content violates usage guidelines."}}',
      }),
    ).toMatchObject({
      class: "invalid_request",
      retryable: false,
      detail: "Content violates usage guidelines.",
    });
    expect(
      resolveProviderError({
        provider: "xai",
        body: '{"code":"The service is currently unavailable","error":"Service temporarily unavailable."}',
      }),
    ).toMatchObject({ class: "server", retryable: true });
  });

  // Documented Responses event shapes; this test states the local status-less retry contract.
  it.each([
    [
      "response.failed",
      {
        type: "response.failed",
        response: { error: { code: "service_unavailable", message: "Model failed" } },
      },
    ],
    [
      "response.error",
      {
        type: "response.error",
        error: { code: "service_unavailable", message: "Model failed" },
      },
    ],
  ] as const)("retries xAI %s events", (_type, event) => {
    expect(resolveProviderError({ provider: "xai", body: JSON.stringify(event) })).toMatchObject({
      class: "server",
      retryable: true,
    });
  });

  it("maps xAI prompt and weekly-limit language", () => {
    expect(
      resolveProviderError({
        provider: "xai",
        body: '{"error":{"message":"This model maximum prompt length is 256000"}}',
      }),
    ).toMatchObject({ class: "context_overflow", retryable: false });
    expect(
      resolveProviderError({
        provider: "xai",
        status: 429,
        body: "You hit your weekly limit. Upgrade to a higher tier for more usage",
      }),
    ).toMatchObject({ class: "quota_exhausted", retryable: false });
  });

  it("carries Codex usage headers through ProviderHttpError", () => {
    const decision = classifyProviderError(
      new ProviderHttpError({
        provider: "codex",
        status: 429,
        body: '{"error":{"type":"usage_limit_reached","message":"Usage limit reached"}}',
        headers: {
          "x-codex-active-limit": "secondary",
          "x-codex-rate-limit-reached-type": "weekly",
        },
      }),
      { provider: "codex" },
    );
    expect(decision).toMatchObject({ kind: "fail", reason: "quota_exhausted" });
    if (decision.kind === "fail") {
      expect(decision.userMessage).toContain("active limit: secondary");
      expect(decision.userMessage).toContain("limit type: weekly");
    }
  });
});

describe("retry timing", () => {
  it("uses Retry-After as a floor beneath computed backoff", () => {
    const delay = getRetryDelay(2, 100, 32_000, 500);
    expect(delay).toBeGreaterThanOrEqual(1_000);
    expect(delay).toBeLessThanOrEqual(1_250);
  });

  it("keeps fractional seconds and HTTP-date Retry-After parsing", () => {
    expect(parseRetryAfterHeader("1.5")).toBe(1_500);
    const delay = parseRetryAfterHeader(new Date(Date.now() + 5_000).toUTCString());
    expect(delay).toBeGreaterThanOrEqual(4_000);
    expect(delay).toBeLessThanOrEqual(5_000);
  });
});
