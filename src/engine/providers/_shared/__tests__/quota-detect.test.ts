import { describe, expect, it } from "bun:test";
import {
  detectQuotaExhaustion,
  ProviderHttpError,
  RETRY_AFTER_TOO_LONG_MS,
} from "@/engine/providers/_shared/retry.ts";
import { classifyProviderError } from "@/engine/transport/_infra/classify/classify.ts";

// Live Z.AI capture (2026-07-09): concurrent burst on /api/anthropic/v1/messages.
// Soft concurrent throttle — Coding Plan monitor can still be far from exhaustion.
const ZAI_SOFT_RATE_LIMIT_BODY =
  '{"type":"error","error":{"type":"rate_limit_error","code":"1302","message":"[1302][Rate limit reached for requests][20260709103839995b57652bce48d3]"},"request_id":"20260709103839995b57652bce48d3"}';

const ANTHROPIC_HARD_USAGE_BODY =
  '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}';

const CODEX_USAGE_LIMIT_BODY =
  '{"error":{"type":"usage_limit_reached","message":"You have reached your usage limit","resets_in_seconds":3600}}';

const OPENAI_QUOTA_BODY =
  '{"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}';

describe("detectQuotaExhaustion — cross-provider", () => {
  it("Z.AI/GLM soft concurrent 429 is not plan exhaustion", () => {
    const result = detectQuotaExhaustion({
      status: 429,
      headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "retry-after": "38",
        "x-should-retry": "true",
      },
      body: ZAI_SOFT_RATE_LIMIT_BODY,
      retryAfterMs: 38_000,
    });
    expect(result.quotaExhausted).toBe(false);
    expect(result.resetEpochMs).toBeNull();
  });

  it("Anthropic hard reject (should-retry false) stays hard quota", () => {
    const result = detectQuotaExhaustion({
      status: 429,
      headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": "1893456000",
        "x-should-retry": "false",
      },
      body: ANTHROPIC_HARD_USAGE_BODY,
    });
    expect(result.quotaExhausted).toBe(true);
    expect(result.resetEpochMs).toBe(1_893_456_000_000);
  });

  it("Anthropic Max/Pro multi-hour block (should-retry true, long reset) stays hard", () => {
    const hoursAwaySec = Math.floor(Date.now() / 1000) + 3 * 3600;
    const result = detectQuotaExhaustion({
      status: 429,
      headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": String(hoursAwaySec),
        "x-should-retry": "true",
      },
      body: ANTHROPIC_HARD_USAGE_BODY,
    });
    expect(result.quotaExhausted).toBe(true);
    expect(result.resetEpochMs).toBe(hoursAwaySec * 1000);
  });

  it("unified rejected + long retry-after stays hard even with should-retry true", () => {
    const result = detectQuotaExhaustion({
      status: 429,
      headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "x-should-retry": "true",
      },
      body: ZAI_SOFT_RATE_LIMIT_BODY,
      retryAfterMs: 3_600_000,
    });
    expect(result.quotaExhausted).toBe(true);
    expect(result.resetEpochMs).not.toBeNull();
  });

  it("unified rejected without known wait stays hard (conservative for Anthropic)", () => {
    const result = detectQuotaExhaustion({
      status: 429,
      headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "x-should-retry": "true",
      },
      body: ANTHROPIC_HARD_USAGE_BODY,
    });
    expect(result.quotaExhausted).toBe(true);
  });

  it("unified rejected without should-retry stays hard", () => {
    const result = detectQuotaExhaustion({
      status: 429,
      headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": "1893456000",
      },
      body: ANTHROPIC_HARD_USAGE_BODY,
    });
    expect(result.quotaExhausted).toBe(true);
  });

  it("Codex usage_limit_reached is hard quota independent of Anthropic headers", () => {
    const result = detectQuotaExhaustion({
      status: 429,
      body: CODEX_USAGE_LIMIT_BODY,
      retryAfterMs: 5_000,
    });
    expect(result.quotaExhausted).toBe(true);
    expect(result.resetEpochMs).not.toBeNull();
  });

  it("OpenAI-style insufficient_quota body is hard quota", () => {
    const result = detectQuotaExhaustion({
      status: 429,
      body: OPENAI_QUOTA_BODY,
      retryAfterMs: 5_000,
    });
    expect(result.quotaExhausted).toBe(true);
  });

  it("plain short 429 without quota markers is soft (minimax/kimi/openai-compat)", () => {
    const result = detectQuotaExhaustion({
      status: 429,
      body: '{"error":{"message":"Too many requests","code":"2062"}}',
      retryAfterMs: 2_000,
    });
    expect(result.quotaExhausted).toBe(false);
  });

  it("long retry-after alone is hard quota for any provider", () => {
    const result = detectQuotaExhaustion({
      status: 429,
      body: '{"error":{"message":"slow down"}}',
      retryAfterMs: RETRY_AFTER_TOO_LONG_MS + 1,
    });
    expect(result.quotaExhausted).toBe(true);
  });

  it("classify path: Z.AI soft 429 becomes retry, not quota_exhausted", () => {
    const quota = detectQuotaExhaustion({
      status: 429,
      headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "x-should-retry": "true",
      },
      body: ZAI_SOFT_RATE_LIMIT_BODY,
      retryAfterMs: 38_000,
    });
    const decision = classifyProviderError(
      new ProviderHttpError({
        provider: "glm /anthropic/v1/messages",
        status: 429,
        body: ZAI_SOFT_RATE_LIMIT_BODY,
        retryAfterHeader: "38",
        shouldRetryHeader: "true",
        quotaExhausted: quota.quotaExhausted,
        quotaResetEpochMs: quota.resetEpochMs,
      }),
      { attempt: 1 },
    );
    expect(decision.kind).toBe("retry");
    if (decision.kind === "retry") {
      expect(decision.delayMs).toBe(38_000);
    }
    expect("quotaExhausted" in decision ? decision.quotaExhausted : false).toBeFalsy();
  });

  it("classify path: Anthropic hard reject stays terminal quota_exhausted", () => {
    const quota = detectQuotaExhaustion({
      status: 429,
      headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": "1893456000",
        "x-should-retry": "false",
      },
      body: ANTHROPIC_HARD_USAGE_BODY,
    });
    const decision = classifyProviderError(
      new ProviderHttpError({
        provider: "/v1/messages",
        status: 429,
        body: ANTHROPIC_HARD_USAGE_BODY,
        retryAfterHeader: null,
        shouldRetryHeader: "false",
        quotaExhausted: quota.quotaExhausted,
        quotaResetEpochMs: quota.resetEpochMs,
      }),
      { attempt: 1 },
    );
    expect(decision.kind).toBe("fail");
    if (decision.kind === "fail") {
      expect(decision.quotaExhausted).toBe(true);
      expect(decision.reason).toBe("quota_exhausted");
    }
  });

  it.each([
    ["glm", 429, '{"error":{"code":"1308","message":"Request rejected"}}'],
    ["minimax", 429, '{"base_resp":{"status_code":1008,"status_msg":"insufficient balance"}}'],
    [
      "kimi",
      429,
      '{"error":{"type":"exceeded_current_quota_error","message":"Current quota exceeded"}}',
    ],
    ["deepseek", 402, '{"error":{"type":"unknown_error","message":"Insufficient Balance"}}'],
    ["xai", 429, "You hit your weekly limit. Upgrade to a higher tier for more usage"],
  ] as const)("stamps %s terminal quota before transport classification", (provider, status, body) => {
    expect(detectQuotaExhaustion({ provider, status, body }).quotaExhausted).toBe(true);
  });
});
