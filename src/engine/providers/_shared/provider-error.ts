const PROVIDER_ERROR_CLASSES = [
  "rate_limit",
  "overloaded",
  "quota_exhausted",
  "auth",
  "invalid_request",
  "context_overflow",
  "server",
  "network",
  "unknown",
] as const;

export type ProviderErrorClass = (typeof PROVIDER_ERROR_CLASSES)[number];

export interface ProviderErrorClassification {
  class: ProviderErrorClass;
  retryable: boolean;
  retryAfterMs?: number;
  provider: string;
  model?: string;
  detail: string;
}

export interface ResolvedProviderError extends ProviderErrorClassification {
  status?: number;
  quotaResetEpochMs?: number | null;
}

export interface ProviderErrorInput {
  provider: string;
  model?: string;
  status?: number;
  body?: string;
  headers?: Headers | Record<string, string | null | undefined>;
  error?: unknown;
  retryAfterMs?: number | null;
}

export interface ProviderErrorRetrySummary {
  retries: number;
  elapsedMs: number;
}

export const RETRY_AFTER_TOO_LONG_MS = 60_000;

const CONTEXT_PATTERNS: readonly RegExp[] = [
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

const QUOTA_PATTERNS: readonly RegExp[] = [
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

const OVERLOAD_PATTERNS: readonly RegExp[] = [
  /overloaded_error/i,
  /server[_\s-]?is[_\s-]?overloaded/i,
  /model[_\s-]?capacity[_\s-]?exhausted/i,
  /server (?:is )?busy/i,
  /capacity.*exhaust/i,
  /prefill[_\s-]queue[_\s-]overloaded/i,
  /(?:prefill|decode).*(?:preempt|pre-empt)|(?:preempt|pre-empt).*(?:prefill|decode)/i,
];

const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /rate[_\s-]?limit/i,
  /too many requests/i,
  /slow[_\s-]?down/i,
  /concurrenc(?:y|t)/i,
];

const AUTH_PATTERNS: readonly RegExp[] = [
  /authentication_error/i,
  /unauthenticated/i,
  /invalid api key/i,
  /invalid(?:[_\s-]+(?:access|auth(?:entication)?))?[_\s-]+token\b/i,
];

const TRANSIENT_NETWORK_CODES = new Set([
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

const TERMINAL_NETWORK_CODES = new Set([
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
]);

const TRANSIENT_NETWORK_PATTERNS: readonly RegExp[] = [
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

const TERMINAL_NETWORK_PATTERNS: readonly RegExp[] = [
  /Hostname\/IP does not match certificate/i,
  /Cert does not contain/i,
  /altnames/i,
  /certificate has expired/i,
  /self[-\s]?signed certificate/i,
  /unable to verify/i,
];

const QUOTA_CODES = new Set([
  "insufficient_quota",
  "usage_limit_reached",
  "usage_not_included",
  "QUOTA_EXHAUSTED",
  "INSUFFICIENT_G1_CREDITS_BALANCE",
]);
const CONTEXT_CODES = new Set(["context_length_exceeded", "request_too_large"]);
const OVERLOAD_CODES = new Set([
  "overloaded_error",
  "server_is_overloaded",
  "MODEL_CAPACITY_EXHAUSTED",
]);
const RATE_LIMIT_CODES = new Set([
  "rate_limit_error",
  "rate_limit_exceeded",
  "RATE_LIMIT_EXCEEDED",
  "RESOURCE_EXHAUSTED",
  "slow_down",
  "2062",
]);
const AUTH_CODES = new Set([
  "authentication_error",
  "permission_error",
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
]);
const INVALID_REQUEST_CODES = new Set([
  "invalid_request_error",
  "invalid_request",
  "invalid-argument",
  "INVALID_ARGUMENT",
  "invalid_prompt",
]);
const SERVER_CODES = new Set(["api_error", "internal_error", "INTERNAL"]);

type ProviderWireRule = Pick<ProviderErrorClassification, "class" | "retryable"> & {
  detailPrefix?: string;
};

const RATE_LIMIT_RULE = { class: "rate_limit", retryable: true } as const;
const OVERLOADED_RULE = { class: "overloaded", retryable: true } as const;
const QUOTA_RULE = { class: "quota_exhausted", retryable: false } as const;
const AUTH_RULE = { class: "auth", retryable: false } as const;
const INVALID_RULE = { class: "invalid_request", retryable: false } as const;
const CONTEXT_RULE = { class: "context_overflow", retryable: false } as const;
const SERVER_RULE = { class: "server", retryable: true } as const;

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
};

const PROVIDER_STATUS_RULES: Readonly<Record<string, Readonly<Record<number, ProviderWireRule>>>> =
  {
    deepseek: {
      402: QUOTA_RULE,
      503: OVERLOADED_RULE,
    },
    xai: {
      403: INVALID_RULE,
    },
  };

interface ParsedWireError {
  eventType: string;
  code: string;
  type: string;
  status: string;
  reason: string;
  message: string;
  uiMessage: string;
  retryDelayMs: number | null;
  resetEpochMs: number | null;
  quotaId: string;
  domain: string;
}

export function resolveProviderError(input: ProviderErrorInput): ResolvedProviderError {
  const body = input.body ?? bodyFromError(input.error);
  const parsed = parseWireError(body);
  const status = input.status ?? statusFromError(input.error) ?? statusFromWire(parsed);
  const retryAfterMs =
    input.retryAfterMs ??
    parseRetryAfterHeader(readHeader(input.headers, "retry-after")) ??
    parsed.retryDelayMs ??
    retryAfterFromMessage(input.provider, parsed);
  const haystack = [
    parsed.eventType,
    parsed.type,
    parsed.code,
    parsed.status,
    parsed.reason,
    parsed.message,
    body,
  ]
    .filter(Boolean)
    .join("\n");
  const detail = providerDetail(
    input,
    parsed,
    conciseDetail(
      parsed.uiMessage || parsed.message || messageFromError(input.error) || body,
      status,
    ),
  );
  const wireRule = providerWireRule(input.provider, parsed, status);
  const eventRule = providerEventRule(input.provider, parsed);
  const common = {
    provider: input.provider,
    ...(input.model !== undefined ? { model: input.model } : {}),
    detail,
    ...(status !== null ? { status } : {}),
    ...(retryAfterMs !== null ? { retryAfterMs } : {}),
  };

  const stampedQuota = quotaFromError(input.error);
  if (stampedQuota.exhausted || wireRule?.class === "quota_exhausted") {
    const resetEpochMs = stampedQuota.exhausted
      ? stampedQuota.resetEpochMs
      : (parsed.resetEpochMs ?? retryReset(retryAfterMs));
    return {
      ...common,
      class: "quota_exhausted",
      retryable: false,
      detail: detailWithReset(common.detail, resetEpochMs),
      quotaResetEpochMs: resetEpochMs,
    };
  }
  if (wireRule) {
    return {
      ...common,
      class: wireRule.class,
      retryable: wireRule.retryable,
      detail: detailWithPrefix(common.detail, wireRule.detailPrefix),
    };
  }
  const quota = quotaResolution({ input, parsed, status, retryAfterMs, haystack });
  if (quota.exhausted) {
    return {
      ...common,
      class: "quota_exhausted",
      retryable: false,
      detail: detailWithReset(common.detail, quota.resetEpochMs),
      quotaResetEpochMs: quota.resetEpochMs,
    };
  }
  if (
    CONTEXT_CODES.has(parsed.code) ||
    CONTEXT_CODES.has(parsed.type) ||
    matches(CONTEXT_PATTERNS, haystack)
  ) {
    return { ...common, class: "context_overflow", retryable: false };
  }
  if (eventRule) return { ...common, ...eventRule };
  if (readHeader(input.headers, "x-should-retry") === "true") {
    const errorClass = status === 429 ? "rate_limit" : status === 529 ? "overloaded" : "server";
    return { ...common, class: errorClass, retryable: true };
  }
  if (
    OVERLOAD_CODES.has(parsed.code) ||
    OVERLOAD_CODES.has(parsed.type) ||
    matches(OVERLOAD_PATTERNS, haystack)
  ) {
    return { ...common, class: "overloaded", retryable: true };
  }
  if (
    RATE_LIMIT_CODES.has(parsed.code) ||
    RATE_LIMIT_CODES.has(parsed.type) ||
    matches(RATE_LIMIT_PATTERNS, haystack) ||
    status === 429
  ) {
    return { ...common, class: "rate_limit", retryable: true };
  }
  if (
    AUTH_CODES.has(parsed.code) ||
    AUTH_CODES.has(parsed.type) ||
    matches(AUTH_PATTERNS, haystack) ||
    status === 401 ||
    status === 403
  ) {
    return { ...common, class: "auth", retryable: false };
  }
  if (status === 408) return { ...common, class: "network", retryable: true };
  if (status === 409 || status === 529) return { ...common, class: "overloaded", retryable: true };
  if (SERVER_CODES.has(parsed.code) || SERVER_CODES.has(parsed.type)) {
    return { ...common, class: "server", retryable: true };
  }
  if (status !== null && status >= 500 && status < 600) {
    return { ...common, class: "server", retryable: true };
  }
  if (
    INVALID_REQUEST_CODES.has(parsed.code) ||
    INVALID_REQUEST_CODES.has(parsed.type) ||
    (status !== null && (status === 400 || status === 404 || status === 413 || status === 422))
  ) {
    return { ...common, class: "invalid_request", retryable: false };
  }
  if (isTransientNetworkError(input.error)) {
    return { ...common, class: "network", retryable: true };
  }
  if (input.error && typeof input.error === "object" && isTerminalNetworkError(input.error)) {
    return { ...common, class: "network", retryable: false };
  }
  return { ...common, class: "unknown", retryable: false };
}

export function formatProviderError(
  error: ProviderErrorClassification,
  retrySummary?: ProviderErrorRetrySummary,
): string {
  const target = error.model ? `${error.provider}/${error.model}` : error.provider;
  const label =
    error.class === "rate_limit"
      ? "rate limited"
      : error.class === "overloaded"
        ? "overloaded"
        : error.class === "quota_exhausted"
          ? "quota exhausted"
          : error.class.replaceAll("_", " ");
  const detail = normalizeDetail(error.detail, error.class);
  const retries =
    retrySummary !== undefined && retrySummary.retries > 0
      ? ` — ${retrySummary.retries} ${retrySummary.retries === 1 ? "retry" : "retries"} over ${formatElapsed(retrySummary.elapsedMs)}`
      : "";
  return `${label} (${target}): ${detail}${retries}`;
}

export function parseRetryAfterHeader(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(trimmed);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - Date.now());
}

export function isTransientNetworkError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (isTerminalNetworkError(error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  if ((error as { name?: unknown }).name === "TimeoutError") return true;
  const message = messageFromError(error);
  if (message && matches(TRANSIENT_NETWORK_PATTERNS, message)) return true;
  return isTransientNetworkError((error as { cause?: unknown }).cause);
}

function providerWireRule(
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
  if (status !== null) {
    const statusRule = PROVIDER_STATUS_RULES[family]?.[status];
    if (statusRule) return statusRule;
  }
  const messageRule = PROVIDER_MESSAGE_RULES[family]?.find(({ pattern }) =>
    pattern.test(parsed.message),
  );
  if (messageRule) return messageRule.rule;
  return null;
}

function providerEventRule(provider: string, parsed: ParsedWireError): ProviderWireRule | null {
  return PROVIDER_WIRE_RULES[providerFamily(provider)]?.[parsed.eventType] ?? null;
}

function providerFamily(provider: string): string {
  return provider.trim().toLowerCase().split(/[\s/]/, 1)[0] ?? "";
}

function retryAfterFromMessage(provider: string, parsed: ParsedWireError): number | null {
  if (
    providerFamily(provider) !== "codex" ||
    (parsed.code !== "rate_limit_exceeded" && parsed.type !== "rate_limit_exceeded")
  ) {
    return null;
  }
  const match = parsed.message.match(/try again in\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/i);
  if (!match?.[1] || !match[2]) return null;
  const value = Number(match[1]);
  return Math.round(match[2].toLowerCase() === "s" ? value * 1_000 : value);
}

function providerDetail(
  input: ProviderErrorInput,
  parsed: ParsedWireError,
  detail: string,
): string {
  if (
    providerFamily(input.provider) !== "codex" ||
    ![parsed.code, parsed.type].some((value) =>
      ["usage_limit_reached", "usage_not_included"].includes(value),
    )
  ) {
    return detail;
  }
  const activeLimit = readHeader(input.headers, "x-codex-active-limit");
  const reachedType = readHeader(input.headers, "x-codex-rate-limit-reached-type");
  const promo = readHeader(input.headers, "x-codex-promo-message");
  const parts = [
    activeLimit ? `active limit: ${activeLimit}` : "",
    reachedType ? `limit type: ${reachedType}` : "",
    promo ? `promo: ${promo}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? `${detail} — ${parts.join("; ")}` : detail;
}

function quotaResolution(input: {
  input: ProviderErrorInput;
  parsed: ParsedWireError;
  status: number | null;
  retryAfterMs: number | null;
  haystack: string;
}): { exhausted: boolean; resetEpochMs: number | null } {
  const unifiedStatus = readHeader(input.input.headers, "anthropic-ratelimit-unified-status");
  if (unifiedStatus === "rejected") {
    const resetSeconds = numericHeader(
      readHeader(input.input.headers, "anthropic-ratelimit-unified-reset"),
    );
    const resetEpochMs = resetSeconds === null ? null : resetSeconds * 1000;
    const waitMs =
      input.retryAfterMs ?? (resetEpochMs === null ? null : Math.max(0, resetEpochMs - Date.now()));
    const shouldRetry = readHeader(input.input.headers, "x-should-retry");
    const soft = shouldRetry === "true" && waitMs !== null && waitMs <= RETRY_AFTER_TOO_LONG_MS;
    return {
      exhausted: !soft,
      resetEpochMs: soft ? null : (resetEpochMs ?? retryReset(input.retryAfterMs)),
    };
  }

  const shouldRetry = readHeader(input.input.headers, "x-should-retry");
  if ((input.status === 429 || input.status === 529) && shouldRetry === "false") {
    return { exhausted: true, resetEpochMs: retryReset(input.retryAfterMs) };
  }
  const shortCapacityWindow =
    input.parsed.quotaId.includes("PerMinute") ||
    input.parsed.quotaId.includes("PerSecond") ||
    (input.parsed.retryDelayMs !== null && input.parsed.retryDelayMs <= 300_000);
  const dailyQuota =
    input.parsed.quotaId.includes("PerDay") || input.parsed.quotaId.includes("Daily");
  if (
    QUOTA_CODES.has(input.parsed.code) ||
    QUOTA_CODES.has(input.parsed.type) ||
    dailyQuota ||
    input.parsed.reason === "GENERATIVE_MODEL_NOT_FOUND" ||
    input.parsed.reason === "MODEL_NOT_FOUND"
  ) {
    return {
      exhausted: !shortCapacityWindow || dailyQuota,
      resetEpochMs: input.parsed.resetEpochMs ?? retryReset(input.retryAfterMs),
    };
  }
  if (
    (input.status === 429 || input.status === 403) &&
    matches(QUOTA_PATTERNS, input.haystack) &&
    input.parsed.code !== "2062" &&
    !shortCapacityWindow
  ) {
    return { exhausted: true, resetEpochMs: retryReset(input.retryAfterMs) };
  }
  if (
    (input.status === 429 || input.status === 529) &&
    input.retryAfterMs !== null &&
    input.retryAfterMs > RETRY_AFTER_TOO_LONG_MS
  ) {
    return { exhausted: true, resetEpochMs: Date.now() + input.retryAfterMs };
  }
  return { exhausted: false, resetEpochMs: null };
}

function parseWireError(body: string): ParsedWireError {
  const empty: ParsedWireError = {
    eventType: "",
    code: "",
    type: "",
    status: "",
    reason: "",
    message: "",
    uiMessage: "",
    retryDelayMs: null,
    resetEpochMs: null,
    quotaId: "",
    domain: "",
  };
  if (body.trim().length === 0) return empty;
  try {
    const value = JSON.parse(body);
    const root = Array.isArray(value) ? value[0] : value;
    const rootRecord = record(root) ?? {};
    const response = record(rootRecord.response);
    const error =
      record(rootRecord.error) ??
      record(response?.error) ??
      record(rootRecord.base_resp) ??
      record(rootRecord.base_response) ??
      rootRecord;
    const errorText = typeof rootRecord.error === "string" ? rootRecord.error : "";
    const metadata = record(error.metadata) ?? {};
    const details = Array.isArray(error.details) ? error.details : [];
    let reason = stringValue(error.reason);
    let uiMessage = stringValue(metadata.uiMessage);
    let retryDelayMs: number | null = null;
    let quotaId = "";
    let domain = "";
    for (const rawDetail of details) {
      const detail = record(rawDetail);
      if (!detail) continue;
      const detailMetadata = record(detail.metadata) ?? {};
      reason ||= stringValue(detail.reason);
      uiMessage ||= stringValue(detailMetadata.uiMessage);
      domain ||= stringValue(detail.domain);
      retryDelayMs ??= durationMs(detail.retryDelay ?? detail.retry_delay);
      const violations = Array.isArray(detail.violations) ? detail.violations : [];
      for (const rawViolation of violations) {
        const violation = record(rawViolation);
        if (violation) quotaId ||= stringValue(violation.quotaId);
      }
    }
    const resetAt = numberValue(error.resets_at) ?? numberValue(metadata.resets_at);
    const resetsIn = numberValue(error.resets_in_seconds);
    return {
      eventType: stringValue(rootRecord.type),
      code: stringValue(error.code || error.status_code || error.error_code),
      type: stringValue(error.type),
      status: stringValue(error.status),
      reason,
      message: stringValue(error.message || error.msg || error.status_msg || errorText),
      uiMessage,
      retryDelayMs,
      resetEpochMs:
        resetAt !== null ? resetAt * 1000 : resetsIn !== null ? Date.now() + resetsIn * 1000 : null,
      quotaId,
      domain,
    };
  } catch {
    return empty;
  }
}

function isTerminalNetworkError(error: object): boolean {
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && TERMINAL_NETWORK_CODES.has(code)) return true;
  const message = messageFromError(error);
  if (message && matches(TERMINAL_NETWORK_PATTERNS, message)) return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause !== undefined && cause !== error && cause && typeof cause === "object"
    ? isTerminalNetworkError(cause)
    : false;
}

function quotaFromError(error: unknown): {
  exhausted: boolean;
  resetEpochMs: number | null;
} {
  if (!error || typeof error !== "object") return { exhausted: false, resetEpochMs: null };
  const exhausted = (error as { quotaExhausted?: unknown }).quotaExhausted === true;
  const reset = (error as { quotaResetEpochMs?: unknown }).quotaResetEpochMs;
  return {
    exhausted,
    resetEpochMs: typeof reset === "number" && Number.isFinite(reset) ? reset : null,
  };
}

function bodyFromError(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const body = (error as { body?: unknown }).body;
  return typeof body === "string" ? body : "";
}

function statusFromError(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number" && status > 0) return status;
  const match = messageFromError(error)?.match(/\bHTTP (\d{3})\b/);
  return match?.[1] ? Number(match[1]) : null;
}

function statusFromWire(parsed: ParsedWireError): number | null {
  if (OVERLOAD_CODES.has(parsed.type) || OVERLOAD_CODES.has(parsed.code)) return 529;
  if (
    RATE_LIMIT_CODES.has(parsed.type) ||
    RATE_LIMIT_CODES.has(parsed.code) ||
    QUOTA_CODES.has(parsed.type) ||
    QUOTA_CODES.has(parsed.code)
  ) {
    return 429;
  }
  if (AUTH_CODES.has(parsed.type) || AUTH_CODES.has(parsed.code)) return 401;
  if (
    CONTEXT_CODES.has(parsed.type) ||
    CONTEXT_CODES.has(parsed.code) ||
    INVALID_REQUEST_CODES.has(parsed.type) ||
    INVALID_REQUEST_CODES.has(parsed.code)
  ) {
    return 400;
  }
  if (SERVER_CODES.has(parsed.type) || SERVER_CODES.has(parsed.code)) return 500;
  return null;
}

function messageFromError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (!error || typeof error !== "object") return typeof error === "string" ? error : "";
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

function conciseDetail(value: string, status: number | null): string {
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length === 0) return status === null ? "unknown error" : `HTTP ${status}`;
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

function detailWithPrefix(detail: string, prefix: string | undefined): string {
  return prefix && !detail.toLowerCase().includes(prefix) ? `${prefix}: ${detail}` : detail;
}

function detailWithReset(detail: string, resetEpochMs: number | null): string {
  if (resetEpochMs === null || !Number.isFinite(resetEpochMs) || /\breset/i.test(detail))
    return detail;
  return `${detail} — resets at ${new Date(resetEpochMs).toISOString()}`;
}

function normalizeDetail(detail: string, errorClass: ProviderErrorClass): string {
  const trimmed = detail.trim();
  if (errorClass === "overloaded" && /^(?:server )?overloaded$/i.test(trimmed)) return "overloaded";
  return trimmed.length > 0 ? trimmed : "unknown error";
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.round(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function readHeader(headers: ProviderErrorInput["headers"], name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  const values = headers as Record<string, string | null | undefined>;
  return values[name] ?? values[name.toLowerCase()] ?? null;
}

function numericHeader(value: string | null): number | null {
  if (value === null || value.trim().length === 0) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function retryReset(retryAfterMs: number | null): number | null {
  return retryAfterMs === null ? null : Date.now() + retryAfterMs;
}

function durationMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)$/);
  if (!match?.[1] || !match[2]) return null;
  const unitMs: Readonly<Record<string, number>> = {
    ns: 0.000_001,
    us: 0.001,
    µs: 0.001,
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
  };
  return Math.round(Number(match[1]) * (unitMs[match[2]] ?? 0));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function matches(patterns: readonly RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value));
}
