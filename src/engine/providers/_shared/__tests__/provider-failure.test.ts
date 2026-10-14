import { describe, expect, it } from "bun:test";
import { resolveProviderError } from "@/engine/providers/_shared/provider-error.ts";
import { AccountVerificationError, type RequestFailure } from "@/kernel/std/types/error-meta.ts";

interface FailureCase {
  provider: string;
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
  failure: RequestFailure;
  retryable: boolean;
}

function failureOf(c: FailureCase): { failure: RequestFailure; retryable: boolean } {
  const resolved = resolveProviderError({
    provider: c.provider,
    ...(c.status !== undefined ? { status: c.status } : {}),
    body: typeof c.body === "string" ? c.body : JSON.stringify(c.body),
    ...(c.headers !== undefined ? { headers: c.headers } : {}),
  });
  return { failure: resolved.failure, retryable: resolved.retryable };
}

function anthropicError(type: string, message: string, extra: object = {}): object {
  return { type: "error", error: { type, message, ...extra } };
}

const CASES: Record<string, FailureCase> = {
  "anthropic: a credit balance too low is billing, whatever the status": {
    provider: "anthropic",
    status: 400,
    body: anthropicError(
      "invalid_request_error",
      "Your credit balance is too low to access the API.",
    ),
    failure: "billing",
    retryable: false,
  },
  "anthropic: billing_error is billing": {
    provider: "anthropic",
    status: 402,
    body: anthropicError("billing_error", "Payment required"),
    failure: "billing",
    retryable: false,
  },
  "anthropic: a verification_required detail asks for verification": {
    provider: "anthropic",
    status: 403,
    body: anthropicError("permission_error", "Verify your organization", {
      details: { error_code: "verification_required" },
    }),
    failure: "verification",
    retryable: false,
  },
  "anthropic: an organization that may not use OAuth is refused": {
    provider: "anthropic",
    status: 403,
    body: anthropicError(
      "permission_error",
      "OAuth authentication is currently not allowed for this organization.",
    ),
    failure: "auth",
    retryable: false,
  },
  "anthropic: a missing model is unavailable": {
    provider: "anthropic",
    status: 404,
    body: anthropicError("not_found_error", "model: claude-unknown"),
    failure: "model_unavailable",
    retryable: false,
  },
  "anthropic: input plus max_tokens over the window is a full context": {
    provider: "anthropic",
    status: 400,
    body: anthropicError(
      "invalid_request_error",
      "input length and `max_tokens` exceed context limit: 190000 + 32000 > 200000",
    ),
    failure: "context_full",
    retryable: false,
  },
  "anthropic: a plain invalid request is unexplained": {
    provider: "anthropic",
    status: 400,
    body: anthropicError(
      "invalid_request_error",
      "messages: text content blocks must be non-empty",
    ),
    failure: "unclassified",
    retryable: false,
  },
  "anthropic: a rejected usage window with a reset is a usage limit": {
    provider: "anthropic",
    status: 429,
    body: anthropicError("rate_limit_error", "This request would exceed your usage limit"),
    headers: {
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": "1893456000",
    },
    failure: "usage_limit",
    retryable: false,
  },
  "anthropic: a rejected window that runs into overage is a throttle": {
    provider: "anthropic",
    status: 429,
    body: anthropicError("rate_limit_error", "Rate limited"),
    headers: {
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": "1893456000",
      "anthropic-ratelimit-unified-overage-status": "allowed",
    },
    failure: "rate_limited",
    retryable: false,
  },
  "anthropic: credits required stops retrying as a throttle": {
    provider: "anthropic",
    status: 429,
    body: anthropicError("rate_limit_error", "Credits required", {
      details: { error_code: "credits_required" },
    }),
    failure: "rate_limited",
    retryable: false,
  },
  "anthropic: an exhausted overload is transient, not a throttle": {
    provider: "anthropic",
    status: 529,
    body: anthropicError("overloaded_error", "Overloaded"),
    headers: { "x-should-retry": "false" },
    failure: "transient",
    retryable: true,
  },
  "anthropic-cloud: shares the Anthropic wire": {
    provider: "anthropic-cloud",
    status: 400,
    body: anthropicError(
      "invalid_request_error",
      "Your credit balance is too low to access the API.",
    ),
    failure: "billing",
    retryable: false,
  },
  "anthropic-cloud: a worker billing_error is billing": {
    provider: "anthropic-cloud",
    body: {
      type: "error",
      error: { type: "insufficient_quota", code: "billing_error", message: "Worker report" },
    },
    failure: "billing",
    retryable: false,
  },
  "anthropic-cloud: a worker model_not_found is model_unavailable": {
    provider: "anthropic-cloud",
    body: {
      type: "error",
      error: { type: "invalid_request_error", code: "model_not_found", message: "Worker report" },
    },
    failure: "model_unavailable",
    retryable: false,
  },
  "anthropic-cloud: a worker account_on_hold is auth": {
    provider: "anthropic-cloud",
    body: {
      type: "error",
      error: { type: "permission_error", code: "account_on_hold", message: "Worker report" },
    },
    failure: "auth",
    retryable: false,
  },
  "anthropic-cloud: a worker verification_required is verification": {
    provider: "anthropic-cloud",
    body: {
      type: "error",
      error: { type: "permission_error", code: "verification_required", message: "Worker report" },
    },
    failure: "verification",
    retryable: false,
  },
  "anthropic-cloud: a worker oauth_org_not_allowed is auth": {
    provider: "anthropic-cloud",
    body: {
      type: "error",
      error: { type: "permission_error", code: "oauth_org_not_allowed", message: "Worker report" },
    },
    failure: "auth",
    retryable: false,
  },
  "anthropic-cloud: a worker cloud_credential_error is transient": {
    provider: "anthropic-cloud",
    body: {
      type: "error",
      error: { type: "api_error", code: "cloud_credential_error", message: "Worker report" },
    },
    failure: "transient",
    retryable: true,
  },
  "anthropic-cloud: a worker rate_limit is rate_limited": {
    provider: "anthropic-cloud",
    body: {
      type: "error",
      error: { type: "rate_limit_error", code: "rate_limit", message: "Worker report" },
    },
    failure: "rate_limited",
    retryable: true,
  },
  "anthropic-cloud: a worker invalid_request is rejected": {
    provider: "anthropic-cloud",
    body: {
      type: "error",
      error: { type: "invalid_request_error", code: "invalid_request", message: "Worker report" },
    },
    failure: "rejected",
    retryable: false,
  },
  "antigravity: a spent quota stays spent despite a short retry": {
    provider: "antigravity",
    status: 429,
    body: {
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Quota exhausted",
        details: [{ reason: "QUOTA_EXHAUSTED" }, { retryDelay: "2s" }],
      },
    },
    failure: "usage_limit",
    retryable: false,
  },
  "antigravity: a short rate limit is a throttle": {
    provider: "antigravity",
    status: 429,
    body: {
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Rate limited",
        details: [{ reason: "RATE_LIMIT_EXCEEDED" }, { retryDelay: "3s" }],
      },
    },
    failure: "rate_limited",
    retryable: true,
  },
  "antigravity: a rate limit that waits for hours is a usage window": {
    provider: "antigravity",
    status: 429,
    body: {
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Rate limited",
        details: [{ reason: "RATE_LIMIT_EXCEEDED" }, { retryDelay: "7200s" }],
      },
    },
    failure: "usage_limit",
    retryable: false,
  },
  "antigravity: spent Google One credits are billing": {
    provider: "antigravity",
    status: 429,
    body: {
      error: {
        code: 429,
        message: "Resource has been exhausted (e.g. check quota).",
        details: [{ reason: "INSUFFICIENT_G1_CREDITS_BALANCE" }, { retryDelay: "2s" }],
      },
    },
    failure: "billing",
    retryable: false,
  },
  "antigravity: VALIDATION_REQUIRED asks for verification": {
    provider: "antigravity",
    status: 403,
    body: {
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        message: "Verify your account",
        details: [
          { reason: "VALIDATION_REQUIRED", domain: "cloudcode-pa.googleapis.com" },
          { links: [{ url: "https://accounts.example.test/verify" }] },
        ],
      },
    },
    failure: "verification",
    retryable: false,
  },
  "antigravity: a terms-of-service block refuses the account": {
    provider: "antigravity",
    status: 403,
    body: {
      error: {
        code: 403,
        message: "This account is suspended.",
        details: [{ reason: "TOS_VIOLATION", metadata: { appeal_url: "https://example.test" } }],
      },
    },
    failure: "auth",
    retryable: false,
  },
  "antigravity: a missing model is unavailable": {
    provider: "antigravity",
    status: 404,
    body: { error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found." } },
    failure: "model_unavailable",
    retryable: false,
  },
  "antigravity: a Gemini token overflow is a full context": {
    provider: "antigravity",
    status: 400,
    body: {
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: "The input token count exceeds the maximum number of tokens allowed 1048576.",
      },
    },
    failure: "context_full",
    retryable: false,
  },
  "antigravity: capacity with a long wait is not retried in place": {
    provider: "antigravity",
    status: 503,
    body: {
      error: {
        code: 503,
        message: "No capacity available",
        details: [{ reason: "MODEL_CAPACITY_EXHAUSTED" }, { retryDelay: "60s" }],
      },
    },
    failure: "transient",
    retryable: false,
  },
  "antigravity: a quota in a field other than the message is not an overload": {
    provider: "antigravity",
    status: 403,
    body: {
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        message: "Daily usage report is not available",
      },
    },
    failure: "auth",
    retryable: false,
  },
  "codex: spent credits are billing": {
    provider: "codex",
    status: 429,
    body: { error: { code: "credit_balance_exhausted", message: "No credits left" } },
    failure: "billing",
    retryable: false,
  },
  "codex: insufficient_quota is billing": {
    provider: "codex",
    status: 429,
    body: { error: { type: "insufficient_quota", message: "You exceeded your current quota" } },
    failure: "billing",
    retryable: false,
  },
  "codex: a plan without Codex refuses the account": {
    provider: "codex",
    status: 429,
    body: { error: { type: "usage_not_included", message: "Upgrade to Plus" } },
    failure: "auth",
    retryable: false,
  },
  "codex: a usage window is a usage limit": {
    provider: "codex",
    status: 429,
    body: { error: { type: "usage_limit_reached", resets_at: 1893456000, message: "Limit" } },
    failure: "usage_limit",
    retryable: false,
  },
  "codex: a usage limit reached on spent workspace credits is billing": {
    provider: "codex",
    status: 429,
    body: { error: { type: "usage_limit_reached", message: "Limit" } },
    headers: { "x-codex-rate-limit-reached-type": "workspace_owner_credits_depleted" },
    failure: "billing",
    retryable: false,
  },
  "codex: a refresh token that expired needs a new sign-in": {
    provider: "codex",
    status: 400,
    body: { error: { code: "refresh_token_expired", message: "Refresh token expired" } },
    failure: "auth",
    retryable: false,
  },
  "codex: an OAuth invalid_grant needs a new sign-in": {
    provider: "codex",
    status: 400,
    body: { error: "invalid_grant", error_description: "Invalid refresh token" },
    failure: "auth",
    retryable: false,
  },
  "codex: a policy block is a refusal": {
    provider: "codex",
    body: {
      type: "response.failed",
      response: { error: { code: "bio_policy", message: "Request blocked" } },
    },
    failure: "rejected",
    retryable: false,
  },
  "codex: a model the ChatGPT plan cannot use is unavailable": {
    provider: "codex",
    status: 400,
    body: {
      detail: "The 'gpt-x' model is not supported when using Codex with a ChatGPT account.",
    },
    failure: "model_unavailable",
    retryable: false,
  },
  "codex: an invalid prompt is rejected": {
    provider: "codex",
    status: 400,
    body: { error: { code: "invalid_prompt", message: "Invalid prompt" } },
    failure: "rejected",
    retryable: false,
  },
  "xai: credits run out is billing, never a retried throttle": {
    provider: "xai",
    status: 429,
    body: {
      code: 429,
      error: "You ran out of credits. [WKE=personal-team-blocked:spending-limit]",
    },
    failure: "billing",
    retryable: false,
  },
  "xai: a blocked team refuses the account": {
    provider: "xai",
    status: 403,
    body: { error: "Your API key or team is blocked." },
    failure: "auth",
    retryable: false,
  },
  "xai: a missing subscription refuses the account": {
    provider: "xai",
    status: 403,
    body: {
      error:
        "You have either run out of available resources or do not have an active Grok subscription.",
    },
    failure: "auth",
    retryable: false,
  },
  "xai: a missing model is unavailable": {
    provider: "xai",
    status: 404,
    body: { error: "model does not exist" },
    failure: "model_unavailable",
    retryable: false,
  },
  "kimi: a 402 membership failure is billing": {
    provider: "kimi",
    status: 402,
    body: {
      error: {
        type: "invalid_request_error",
        message: "We're unable to verify your membership benefits.",
      },
    },
    failure: "billing",
    retryable: false,
  },
  "kimi: an untyped token quota is billing, not a retried throttle": {
    provider: "kimi",
    status: 429,
    body: { error: { message: "You exceeded your current token quota, please recharge." } },
    failure: "billing",
    retryable: false,
  },
  "kimi: a usage window is a usage limit": {
    provider: "kimi",
    status: 403,
    body: {
      error: {
        type: "access_terminated_error",
        message: "You've reached your 5-hour usage limit. Please try again later.",
      },
    },
    failure: "usage_limit",
    retryable: false,
  },
  "kimi: a concurrency block refuses the account": {
    provider: "kimi",
    status: 403,
    body: {
      error: {
        type: "access_terminated_error",
        message: "You've exceeded the concurrent request limit.",
      },
    },
    failure: "auth",
    retryable: false,
  },
  "kimi: a model the plan lacks is unavailable": {
    provider: "kimi",
    status: 401,
    body: {
      error: { message: "Your current subscription does not have access to k3." },
    },
    failure: "model_unavailable",
    retryable: false,
  },
  "kimi: a request over the model token limit is a full context": {
    provider: "kimi",
    status: 400,
    body: {
      error: {
        type: "invalid_request_error",
        message:
          "Invalid request: Your request exceeded model token limit: 262144 (requested: 300000)",
      },
    },
    failure: "context_full",
    retryable: false,
  },
  "kimi: a body over the size cap is rejected": {
    provider: "kimi",
    status: 400,
    body: {
      error: {
        type: "invalid_request_error",
        message: "total message size 5943865 exceeds limit 2097152",
      },
    },
    failure: "rejected",
    retryable: false,
  },
  "kimi: high-risk content is a refusal": {
    provider: "kimi",
    status: 400,
    body: {
      error: {
        type: "content_filter",
        message: "The request was rejected because it was considered high risk",
      },
    },
    failure: "rejected",
    retryable: false,
  },
  "deepseek: a balance at zero is billing": {
    provider: "deepseek",
    status: 402,
    body: { error: { message: "Insufficient Balance", type: "unknown_error" } },
    failure: "billing",
    retryable: false,
  },
  "deepseek: risky content is a refusal": {
    provider: "deepseek",
    status: 400,
    body: { error: { message: "Content Exists Risk", type: "invalid_request_error" } },
    failure: "rejected",
    retryable: false,
  },
  "glm: arrears are billing": {
    provider: "glm",
    status: 429,
    body: {
      type: "error",
      error: { type: "rate_limit_error", code: "1113", message: "[1113][arrears]" },
    },
    failure: "billing",
    retryable: false,
  },
  "glm: a five-hour window is a usage limit": {
    provider: "glm",
    status: 429,
    body: {
      type: "error",
      error: { type: "rate_limit_error", code: "1308", message: "[1308][limit]" },
    },
    failure: "usage_limit",
    retryable: false,
  },
  "glm: a plan without the model is unavailable": {
    provider: "glm",
    status: 429,
    body: {
      type: "error",
      error: { type: "rate_limit_error", code: "1311", message: "[1311][model]" },
    },
    failure: "model_unavailable",
    retryable: false,
  },
  "glm: a fair-use restriction refuses the account": {
    provider: "glm",
    status: 429,
    body: {
      type: "error",
      error: { type: "rate_limit_error", code: "1313", message: "[1313][fair use]" },
    },
    failure: "auth",
    retryable: false,
  },
  "glm: a prompt too long is a full context": {
    provider: "glm",
    status: 400,
    body: {
      type: "error",
      error: { type: "invalid_request_error", code: "1261", message: "Prompt too long" },
    },
    failure: "context_full",
    retryable: false,
  },
  "glm: sensitive content is a refusal": {
    provider: "glm",
    status: 400,
    body: {
      type: "error",
      error: { type: "invalid_request_error", code: "1301", message: "[1301][sensitive]" },
    },
    failure: "rejected",
    retryable: false,
  },
  "minimax: a code at the end of the message is read": {
    provider: "minimax",
    status: 429,
    body: {
      type: "error",
      error: { type: "rate_limit_error", message: "Token Plan usage limit reached (2067)" },
    },
    failure: "usage_limit",
    retryable: false,
  },
  "minimax: an empty balance is billing even on a 500": {
    provider: "minimax",
    status: 500,
    body: { type: "error", error: { type: "api_error", message: "insufficient balance (1008)" } },
    failure: "billing",
    retryable: false,
  },
  "minimax: the concurrency cap stays a retried throttle": {
    provider: "minimax",
    status: 429,
    body: {
      type: "error",
      error: { type: "rate_limit_error", message: "concurrency limit (2062)" },
    },
    failure: "rate_limited",
    retryable: true,
  },
};

describe("what a provider failure means", () => {
  it("antigravity: an account to verify differs from one refused outright", () => {
    const failureFor = (ineligible: boolean): RequestFailure =>
      resolveProviderError({
        provider: "antigravity",
        error: new AccountVerificationError({
          provider: "antigravity",
          reason: "This account is not eligible",
          verificationUrl: "",
          ineligible,
        }),
      }).failure;
    expect(failureFor(false)).toBe("verification");
    expect(failureFor(true)).toBe("auth");
  });

  it("any provider: no stored sign-in needs a new sign-in", () => {
    expect(
      resolveProviderError({
        provider: "glm",
        error: new Error("not logged in to glm — run `otherside login --provider glm`"),
      }),
    ).toMatchObject({ class: "auth", retryable: false, failure: "auth" });
  });

  for (const [name, c] of Object.entries(CASES)) {
    it(name, () => {
      expect(failureOf(c)).toEqual({ failure: c.failure, retryable: c.retryable });
    });
  }
});
