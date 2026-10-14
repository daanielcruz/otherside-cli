import type { RequestFailure } from "@/kernel/std/types/error-meta.ts";
import type { ParsedWireError } from "./error-wire.ts";
import type { ProviderErrorClassification } from "./provider-error.ts";

/**
 * Classification rule catalog: per-provider wire codes, shared code sets, and
 * message/status patterns that map provider errors onto error classes.
 */

export type ProviderWireRule = Pick<ProviderErrorClassification, "class" | "retryable"> & {
  detailPrefix?: string;
  /** Set when the class alone would misread what the failure means. */
  failure?: RequestFailure;
  /** When the provider names a wait, the request is retried only if the wait is at most this long. */
  retryWithinMs?: number;
};

export const CONTEXT_PATTERNS: readonly RegExp[] = [
  /exceeds the context window/i,
  /context length/i,
  /context_length_exceeded/i,
  /prompt is too long/i,
  /maximum context length/i,
  /input is too long/i,
  /reduce the length/i,
  /request too large/i,
  /maximum prompt length/i,
  /input token length too long/i,
  /prompt tokens\s*\+\s*max_tokens.*exceed/i,
  /input length and `?max_tokens`? exceed context limit/i,
  /input token count exceeds the maximum number of tokens/i,
  /exceeded model token limit/i,
  /supports only .+ up to \d+k? context/i,
  /prompt too long/i,
];

export const QUOTA_PATTERNS: readonly RegExp[] = [
  /insufficient[_\s-]?quota/i,
  /quota[_\s-]?exceeded/i,
  /quota[_\s-]?exhaust/i,
  /usage[_\s-]?limit/i,
  /billing[_\s-]?hard[_\s-]?limit/i,
  /you exceeded your current quota/i,
  /maximum.*quota/i,
  /insufficient.*credits/i,
  /insufficient.*balance/i,
  /exceeded_current_quota_error/i,
  /billing_error/i,
  /weekly.*limit/i,
];

export const OVERLOAD_PATTERNS: readonly RegExp[] = [
  /overloaded_error/i,
  /server[_\s-]?is[_\s-]?overloaded/i,
  /model[_\s-]?capacity[_\s-]?exhausted/i,
  /server (?:is )?busy/i,
  /capacity.*exhaust/i,
  /prefill[_\s-]queue[_\s-]overloaded/i,
  /(?:prefill|decode).*(?:preempt|pre-empt)|(?:preempt|pre-empt).*(?:prefill|decode)/i,
  /thread is cancelled before we get prefill results/i,
];

export const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /rate[_\s-]?limit/i,
  /too many requests/i,
  /slow[_\s-]?down/i,
  /concurren(?:cy|t)/i,
];

export const AUTH_PATTERNS: readonly RegExp[] = [
  /authentication_error/i,
  /\binvalid_grant\b/i,
  /refresh_token_(?:expired|reused|invalidated)/i,
  /unauthenticated/i,
  /invalid api key/i,
  /invalid(?:[_\s-]+(?:access|auth(?:entication)?))?[_\s-]+token\b/i,
];

export const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
]);

export const TERMINAL_NETWORK_CODES = new Set([
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
]);

export const TRANSIENT_NETWORK_PATTERNS: readonly RegExp[] = [
  /ECONNRESET/i,
  /EPIPE/i,
  /ETIMEDOUT/i,
  /UND_ERR_SOCKET/i,
  /fetch failed/i,
  /network/i,
  /connection refused/i,
  /socket connection was closed unexpectedly/i,
  /websocket.*closed/i,
  /ws closed before completion/i,
  /operation timed out/i,
  /unable to connect/i,
  /was there a typo in the url or port/i,
  /failed to connect/i,
];

export const TERMINAL_NETWORK_PATTERNS: readonly RegExp[] = [
  /Hostname\/IP does not match certificate/i,
  /Cert does not contain/i,
  /altnames/i,
  /certificate has expired/i,
  /self[-\s]?signed certificate/i,
  /unable to verify/i,
];

export const QUOTA_CODES = new Set([
  "insufficient_quota",
  "usage_limit_reached",
  "usage_not_included",
  "QUOTA_EXHAUSTED",
  "INSUFFICIENT_G1_CREDITS_BALANCE",
]);
export const CONTEXT_CODES = new Set(["context_length_exceeded", "exceed_context_size_error"]);
/** A body over the transport limit: its bytes, not its tokens, are the problem. */
export const REQUEST_TOO_LARGE_CODES = new Set(["request_too_large"]);
/** A size rejection that still names the context window is a token overflow, not a body overflow. */
export const CONTEXT_WINDOW_NAMED_PATTERNS: readonly RegExp[] = [
  /context window/i,
  /prompt is too long/i,
  /prompt_too_long/i,
];
export const OVERLOAD_CODES = new Set([
  "overloaded_error",
  "server_is_overloaded",
  "MODEL_CAPACITY_EXHAUSTED",
]);
export const RATE_LIMIT_CODES = new Set([
  "rate_limit_error",
  "rate_limit_exceeded",
  "RATE_LIMIT_EXCEEDED",
  "RESOURCE_EXHAUSTED",
  "slow_down",
  "2062",
]);
export const AUTH_CODES = new Set([
  "authentication_error",
  "permission_error",
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
]);
export const INVALID_REQUEST_CODES = new Set([
  "invalid_request_error",
  "invalid_request",
  "invalid-argument",
  "INVALID_ARGUMENT",
  "invalid_prompt",
]);
export const SERVER_CODES = new Set(["api_error", "internal_error", "INTERNAL"]);

const RATE_LIMIT_RULE = { class: "rate_limit", retryable: true } as const;
const OVERLOADED_RULE = { class: "overloaded", retryable: true } as const;
const QUOTA_RULE = { class: "quota_exhausted", retryable: false } as const;
const AUTH_RULE = { class: "auth", retryable: false } as const;
const INVALID_RULE = { class: "invalid_request", retryable: false } as const;
const CONTEXT_RULE = { class: "context_overflow", retryable: false } as const;
const SERVER_RULE = { class: "server", retryable: true } as const;
const TOO_LARGE_RULE = { class: "request_too_large", retryable: false } as const;

/** Credits or payment ran out: the quota stops, and no window resets it. */
const BILLING_RULE: ProviderWireRule = { ...QUOTA_RULE, failure: "billing" };
/** A cap that stops retries but lifts like a throttle once the window moves. */
const CAPPED_RATE_RULE: ProviderWireRule = { ...QUOTA_RULE, failure: "rate_limited" };
/** The account itself is refused: blocked, on hold, or not allowed to use this client. */
const ACCOUNT_BLOCKED_RULE: ProviderWireRule = { ...AUTH_RULE, failure: "auth" };
const VERIFICATION_RULE: ProviderWireRule = { ...AUTH_RULE, failure: "verification" };
const MODEL_UNAVAILABLE_RULE: ProviderWireRule = { ...INVALID_RULE, failure: "model_unavailable" };
/** A request the provider will refuse again exactly as sent. */
const REJECTED_RULE: ProviderWireRule = { ...INVALID_RULE, failure: "rejected" };
/** Content the provider's safety filter refused. */
const REFUSAL_RULE: ProviderWireRule = { ...REJECTED_RULE, detailPrefix: "content filtered" };

// Z.AI chat-error codes: the number rides in `error.code` and opens the message as `[13xx]`.
const ZHIPU_CODE_RULES: Readonly<Record<string, ProviderWireRule>> = {
  "1000": AUTH_RULE,
  "1001": AUTH_RULE,
  "1003": AUTH_RULE,
  "1005": VERIFICATION_RULE,
  "1113": BILLING_RULE,
  "1200": SERVER_RULE,
  "1211": MODEL_UNAVAILABLE_RULE,
  "1220": ACCOUNT_BLOCKED_RULE,
  "1221": MODEL_UNAVAILABLE_RULE,
  "1222": MODEL_UNAVAILABLE_RULE,
  "1230": SERVER_RULE,
  "1234": SERVER_RULE,
  "1261": CONTEXT_RULE,
  "1301": REFUSAL_RULE,
  "1302": RATE_LIMIT_RULE,
  "1303": RATE_LIMIT_RULE,
  "1304": QUOTA_RULE,
  "1305": OVERLOADED_RULE,
  "1308": QUOTA_RULE,
  "1309": BILLING_RULE,
  "1310": QUOTA_RULE,
  "1311": { ...QUOTA_RULE, failure: "model_unavailable" },
  "1312": RATE_LIMIT_RULE,
  "1313": { ...QUOTA_RULE, failure: "auth" },
  "1314": BILLING_RULE,
  "1315": { ...QUOTA_RULE, failure: "auth" },
  "1316": QUOTA_RULE,
  "1317": QUOTA_RULE,
  "1318": QUOTA_RULE,
  "1319": QUOTA_RULE,
  "1320": QUOTA_RULE,
  "1321": QUOTA_RULE,
};

// MiniMax codes: the number rides in `base_resp.status_code`, or ends the message as `(NNNN)`.
const MINIMAX_CODE_RULES: Readonly<Record<string, ProviderWireRule>> = {
  "1000": SERVER_RULE,
  "1001": SERVER_RULE,
  "1002": RATE_LIMIT_RULE,
  "1004": AUTH_RULE,
  "1008": BILLING_RULE,
  "1024": SERVER_RULE,
  "1026": REFUSAL_RULE,
  "1027": REFUSAL_RULE,
  "1033": SERVER_RULE,
  "1039": CONTEXT_RULE,
  "1041": RATE_LIMIT_RULE,
  "1042": REJECTED_RULE,
  "2013": REJECTED_RULE,
  "2045": RATE_LIMIT_RULE,
  "2049": AUTH_RULE,
  "2056": QUOTA_RULE,
  "2062": RATE_LIMIT_RULE,
  "2064": OVERLOADED_RULE,
  "2067": QUOTA_RULE,
};

const ANTHROPIC_WIRE_RULES: Readonly<Record<string, ProviderWireRule>> = {
  billing_error: BILLING_RULE,
  credits_required: CAPPED_RATE_RULE,
  not_found_error: MODEL_UNAVAILABLE_RULE,
  service_spend_limit_reached: CAPPED_RATE_RULE,
  timeout_error: SERVER_RULE,
  verification_required: VERIFICATION_RULE,
};

const ANTHROPIC_MESSAGE_RULES: readonly { pattern: RegExp; rule: ProviderWireRule }[] = [
  { pattern: /credit balance is too low/i, rule: BILLING_RULE },
  {
    pattern: /oauth authentication is currently not allowed for this organization/i,
    rule: ACCOUNT_BLOCKED_RULE,
  },
  { pattern: /organization has been disabled/i, rule: ACCOUNT_BLOCKED_RULE },
  { pattern: /oauth token has been revoked/i, rule: AUTH_RULE },
];

// A managed Cloud worker reports a failed request as an error kind of its own.
const CLOUD_WIRE_RULES: Readonly<Record<string, ProviderWireRule>> = {
  ...ANTHROPIC_WIRE_RULES,
  account_on_hold: ACCOUNT_BLOCKED_RULE,
  authentication_failed: AUTH_RULE,
  cloud_credential_error: SERVER_RULE,
  invalid_request: REJECTED_RULE,
  max_output_tokens: SERVER_RULE,
  model_not_found: MODEL_UNAVAILABLE_RULE,
  oauth_org_not_allowed: ACCOUNT_BLOCKED_RULE,
};

const PROVIDER_WIRE_RULES: Readonly<Record<string, Readonly<Record<string, ProviderWireRule>>>> = {
  anthropic: ANTHROPIC_WIRE_RULES,
  "anthropic-cloud": CLOUD_WIRE_RULES,
  antigravity: {
    GENERATIVE_MODEL_NOT_FOUND: MODEL_UNAVAILABLE_RULE,
    INSUFFICIENT_G1_CREDITS_BALANCE: BILLING_RULE,
    MODEL_CAPACITY_EXHAUSTED: { ...OVERLOADED_RULE, retryWithinMs: 30_000 },
    MODEL_NOT_FOUND: MODEL_UNAVAILABLE_RULE,
    PREFILL_QUEUE_OVERLOADED: OVERLOADED_RULE,
    QUOTA_EXHAUSTED: QUOTA_RULE,
    SERVICE_DISABLED: ACCOUNT_BLOCKED_RULE,
    TOS_VIOLATION: ACCOUNT_BLOCKED_RULE,
    UNAVAILABLE: SERVER_RULE,
    VALIDATION_REQUIRED: VERIFICATION_RULE,
  },
  codex: {
    bio_policy: REFUSAL_RULE,
    credit_balance_exhausted: BILLING_RULE,
    cyber_policy: REFUSAL_RULE,
    insufficient_quota: BILLING_RULE,
    invalid_prompt: REJECTED_RULE,
    misalignment_policy_violation: REFUSAL_RULE,
    organization_spend_limit_exceeded: BILLING_RULE,
    organization_usage_limit_exceeded: BILLING_RULE,
    project_spend_limit_exceeded: BILLING_RULE,
    // A model at capacity is retried only when the provider says when to come back.
    server_is_overloaded: { class: "overloaded", retryable: false, retryWithinMs: Infinity },
    slow_down: RATE_LIMIT_RULE,
    usage_not_included: { ...QUOTA_RULE, failure: "auth" },
  },
  glm: ZHIPU_CODE_RULES,
  kimi: {
    content_filter: REFUSAL_RULE,
    exceeded_current_quota_error: BILLING_RULE,
    permission_denied_error: ACCOUNT_BLOCKED_RULE,
    resource_not_found_error: MODEL_UNAVAILABLE_RULE,
  },
  minimax: MINIMAX_CODE_RULES,
  xai: {
    "subscription:free-usage-exhausted": QUOTA_RULE,
    "The service is currently unavailable": SERVER_RULE,
    "response.error": SERVER_RULE,
    "response.failed": SERVER_RULE,
    server_error: SERVER_RULE,
  },
};

const PROVIDER_MESSAGE_RULES: Readonly<
  Record<string, readonly { pattern: RegExp; rule: ProviderWireRule }[]>
> = {
  anthropic: ANTHROPIC_MESSAGE_RULES,
  "anthropic-cloud": ANTHROPIC_MESSAGE_RULES,
  codex: [
    {
      pattern: /model is not supported when using codex with a chatgpt account/i,
      rule: MODEL_UNAVAILABLE_RULE,
    },
  ],
  deepseek: [
    { pattern: /insufficient balance/i, rule: BILLING_RULE },
    { pattern: /content exists risk/i, rule: REFUSAL_RULE },
  ],
  kimi: [
    { pattern: /total message size \d+ exceeds limit/i, rule: TOO_LARGE_RULE },
    { pattern: /does not have access to|recognized as other:/i, rule: MODEL_UNAVAILABLE_RULE },
    {
      pattern: /exceeded your current (?:token )?quota|insufficient balance|please recharge/i,
      rule: BILLING_RULE,
    },
    {
      pattern: /concurrent request limit|access terminated|only available for coding agents/i,
      rule: ACCOUNT_BLOCKED_RULE,
    },
  ],
  minimax: [
    { pattern: /insufficient balance/i, rule: BILLING_RULE },
    { pattern: /用量上限|使用上限/, rule: QUOTA_RULE },
  ],
  xai: [
    { pattern: /r[au]n out of credits|spending-limit/i, rule: BILLING_RULE },
    { pattern: /violates usage guidelines/i, rule: REFUSAL_RULE },
    {
      pattern:
        /is blocked|access to the chat endpoint is denied|active grok subscription|requires a grok subscription/i,
      rule: ACCOUNT_BLOCKED_RULE,
    },
    { pattern: /model does not exist/i, rule: MODEL_UNAVAILABLE_RULE },
  ],
};

const PROVIDER_STATUS_RULES: Readonly<Record<string, Readonly<Record<number, ProviderWireRule>>>> =
  {
    deepseek: {
      402: BILLING_RULE,
      503: OVERLOADED_RULE,
    },
    kimi: {
      402: BILLING_RULE,
    },
    xai: {
      402: QUOTA_RULE,
      403: INVALID_RULE,
    },
  };

export function providerWireRule(
  provider: string,
  parsed: ParsedWireError,
  status: number | null,
): ProviderWireRule | null {
  const family = providerFamily(provider);
  const rules = PROVIDER_WIRE_RULES[family];
  if (rules) {
    for (const value of [parsed.code, parsed.type, parsed.reason, parsed.status]) {
      const rule = rules[value];
      if (rule) return rule;
    }
  }
  const messageRule = PROVIDER_MESSAGE_RULES[family]?.find(({ pattern }) =>
    pattern.test(parsed.message),
  );
  if (messageRule) return messageRule.rule;
  if (status !== null) {
    const statusRule = PROVIDER_STATUS_RULES[family]?.[status];
    if (statusRule) return statusRule;
  }
  return null;
}

export function providerEventRule(
  provider: string,
  parsed: ParsedWireError,
): ProviderWireRule | null {
  return PROVIDER_WIRE_RULES[providerFamily(provider)]?.[parsed.eventType] ?? null;
}

export function providerFamily(provider: string): string {
  return provider.trim().toLowerCase().split(/[\s/]/, 1)[0] ?? "";
}

export function matches(patterns: readonly RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value));
}
