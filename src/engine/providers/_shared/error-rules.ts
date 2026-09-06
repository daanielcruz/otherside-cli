import type { ParsedWireError } from "./error-wire.ts";
import type { ProviderErrorClassification } from "./provider-error.ts";

/**
 * Classification rule catalog: per-provider wire codes, shared code sets, and
 * message/status patterns that map provider errors onto error classes.
 */

export type ProviderWireRule = Pick<ProviderErrorClassification, "class" | "retryable"> & {
  detailPrefix?: string;
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
  /perday|daily/i,
];

export const OVERLOAD_PATTERNS: readonly RegExp[] = [
  /overloaded_error/i,
  /server[_\s-]?is[_\s-]?overloaded/i,
  /model[_\s-]?capacity[_\s-]?exhausted/i,
  /server (?:is )?busy/i,
  /capacity.*exhaust/i,
  /prefill[_\s-]queue[_\s-]overloaded/i,
  /(?:prefill|decode).*(?:preempt|pre-empt)|(?:preempt|pre-empt).*(?:prefill|decode)/i,
];

export const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /rate[_\s-]?limit/i,
  /too many requests/i,
  /slow[_\s-]?down/i,
  /concurrenc(?:y|t)/i,
];

export const AUTH_PATTERNS: readonly RegExp[] = [
  /authentication_error/i,
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
export const CONTEXT_CODES = new Set(["context_length_exceeded", "request_too_large"]);
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

// 1314/1315 are Z.AI chat-error codes in the provider-limit band; exact semantics
// are unproven, so they stay terminal quota (do not thrash retries).
const ZHIPU_CODE_RULES: Readonly<Record<string, ProviderWireRule>> = {
  "1113": QUOTA_RULE,
  "1302": RATE_LIMIT_RULE,
  "1303": RATE_LIMIT_RULE,
  "1304": QUOTA_RULE,
  "1305": OVERLOADED_RULE,
  "1308": QUOTA_RULE,
  "1309": QUOTA_RULE,
  "1310": QUOTA_RULE,
  "1311": QUOTA_RULE,
  "1312": RATE_LIMIT_RULE,
  "1313": QUOTA_RULE,
  "1314": QUOTA_RULE,
  "1315": QUOTA_RULE,
  "1316": QUOTA_RULE,
  "1317": QUOTA_RULE,
  "1318": QUOTA_RULE,
  "1319": QUOTA_RULE,
  "1320": QUOTA_RULE,
  "1321": QUOTA_RULE,
};

const MINIMAX_CODE_RULES: Readonly<Record<string, ProviderWireRule>> = {
  "1000": SERVER_RULE,
  "1001": SERVER_RULE,
  "1002": RATE_LIMIT_RULE,
  "1008": QUOTA_RULE,
  "1024": SERVER_RULE,
  "1026": { ...INVALID_RULE, detailPrefix: "content filtered" },
  "1027": { ...INVALID_RULE, detailPrefix: "content filtered" },
  "1033": SERVER_RULE,
  "1039": CONTEXT_RULE,
  "1041": RATE_LIMIT_RULE,
  "2045": RATE_LIMIT_RULE,
  "2056": QUOTA_RULE,
  "2062": RATE_LIMIT_RULE,
};

const PROVIDER_WIRE_RULES: Readonly<Record<string, Readonly<Record<string, ProviderWireRule>>>> = {
  anthropic: {
    billing_error: QUOTA_RULE,
    not_found_error: INVALID_RULE,
    timeout_error: SERVER_RULE,
  },
  antigravity: {
    MODEL_CAPACITY_EXHAUSTED: OVERLOADED_RULE,
    PREFILL_QUEUE_OVERLOADED: OVERLOADED_RULE,
    QUOTA_EXCEEDED: QUOTA_RULE,
    UNAVAILABLE: SERVER_RULE,
    VERIFICATION_REQUIRED: AUTH_RULE,
  },
  codex: {
    cyber_policy: INVALID_RULE,
    server_is_overloaded: { class: "overloaded", retryable: false },
    slow_down: { class: "overloaded", retryable: false },
  },
  glm: ZHIPU_CODE_RULES,
  kimi: {
    exceeded_current_quota_error: QUOTA_RULE,
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
  deepseek: [{ pattern: /insufficient balance/i, rule: QUOTA_RULE }],
  xai: [{ pattern: /run out of credits/i, rule: QUOTA_RULE }],
};

const PROVIDER_STATUS_RULES: Readonly<Record<string, Readonly<Record<number, ProviderWireRule>>>> =
  {
    deepseek: {
      402: QUOTA_RULE,
      503: OVERLOADED_RULE,
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
