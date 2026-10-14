import { formatResetTime } from "@/kernel/std/intl.ts";
import { StreamSilenceError } from "@/kernel/std/stream/idle-timeout.ts";
import {
  AccountVerificationError,
  type RequestFailure,
  withVerificationLink,
} from "@/kernel/std/types/error-meta.ts";
import {
  AUTH_CODES,
  AUTH_PATTERNS,
  CONTEXT_CODES,
  CONTEXT_PATTERNS,
  CONTEXT_WINDOW_NAMED_PATTERNS,
  INVALID_REQUEST_CODES,
  matches,
  OVERLOAD_CODES,
  OVERLOAD_PATTERNS,
  type ProviderWireRule,
  providerEventRule,
  providerFamily,
  providerWireRule,
  QUOTA_CODES,
  QUOTA_PATTERNS,
  RATE_LIMIT_CODES,
  RATE_LIMIT_PATTERNS,
  REQUEST_TOO_LARGE_CODES,
  SERVER_CODES,
  TERMINAL_NETWORK_CODES,
  TERMINAL_NETWORK_PATTERNS,
  TRANSIENT_NETWORK_CODES,
  TRANSIENT_NETWORK_PATTERNS,
} from "./error-rules.ts";
import { type ParsedWireError, parseWireError } from "./error-wire.ts";

const PROVIDER_ERROR_CLASSES = [
  "rate_limit",
  "overloaded",
  "quota_exhausted",
  "auth",
  "invalid_request",
  "context_overflow",
  "request_too_large",
  "server",
  "network",
  "unknown",
] as const;

export type ProviderErrorClass = (typeof PROVIDER_ERROR_CLASSES)[number];

export interface ProviderErrorClassification {
  class: ProviderErrorClass;
  retryable: boolean;
  /** What the failure means for the work that sent the request, whatever the provider. */
  failure: RequestFailure;
  retryAfterMs?: number;
  provider: string;
  model?: string;
  detail: string;
}

export interface ResolvedProviderError extends ProviderErrorClassification {
  status?: number;
  quotaResetEpochMs?: number | null;
}

/** A class resolved before its failure: a rule names the failure only when the class alone would misread it. */
type ClassResolution = Omit<ResolvedProviderError, "failure"> & { failure?: RequestFailure };

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
/** A wait longer than this outlasts any throttle: the account waits for a usage window. */
const USAGE_WINDOW_WAIT_MS = 300_000;

export function resolveProviderError(input: ProviderErrorInput): ResolvedProviderError {
  const resolved = resolveProviderClass(input);
  return { ...resolved, failure: resolved.failure ?? failureOfClass(resolved) };
}

/** The failure a class stands for when no rule says more. */
function failureOfClass(resolved: ClassResolution): RequestFailure {
  switch (resolved.class) {
    case "rate_limit":
      return "rate_limited";
    case "overloaded":
    case "server":
    case "network":
      return "transient";
    case "quota_exhausted":
      return "usage_limit";
    case "auth":
      return "auth";
    case "invalid_request":
      // A request refused without a named reason may go through on a later try;
      // a missing model will not.
      return resolved.status === 404 ? "model_unavailable" : "unclassified";
    case "context_overflow":
      return "context_full";
    case "request_too_large":
      return "rejected";
    case "unknown":
      return "unclassified";
  }
}

function resolveProviderClass(input: ProviderErrorInput): ClassResolution {
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

  // No stored sign-in at all: nothing but signing in again serves the request.
  if (/\bnot logged in\b/i.test(messageFromError(input.error))) {
    return { ...common, class: "auth", retryable: false };
  }
  // The link is longer than any excerpt of a message, so it rides outside the excerpt.
  if (input.error instanceof AccountVerificationError) {
    return {
      ...common,
      class: "auth",
      retryable: false,
      failure: input.error.ineligible ? "auth" : "verification",
      detail: withVerificationLink(
        conciseDetail(input.error.reason, status),
        input.error.verificationUrl,
      ),
    };
  }
  const stampedQuota = quotaFromError(input.error);
  if (stampedQuota.exhausted || wireRule?.class === "quota_exhausted") {
    const resetEpochMs = stampedQuota.exhausted
      ? stampedQuota.resetEpochMs
      : (parsed.resetEpochMs ?? retryReset(retryAfterMs));
    return {
      ...common,
      class: "quota_exhausted",
      retryable: false,
      ...(wireRule?.failure !== undefined ? { failure: wireRule.failure } : {}),
      detail: detailWithReset(
        detailWithPrefix(common.detail, wireRule?.detailPrefix),
        resetEpochMs,
      ),
      quotaResetEpochMs: resetEpochMs,
    };
  }
  if (wireRule) {
    return {
      ...common,
      class: wireRule.class,
      retryable: ruleRetryable(wireRule, retryAfterMs),
      ...(wireRule.failure !== undefined ? { failure: wireRule.failure } : {}),
      detail: detailWithPrefix(common.detail, wireRule.detailPrefix),
    };
  }
  const quota = quotaResolution({ input, parsed, status, retryAfterMs, haystack });
  if (quota.exhausted) {
    return {
      ...common,
      class: "quota_exhausted",
      retryable: false,
      ...(quota.failure !== undefined ? { failure: quota.failure } : {}),
      detail: detailWithReset(common.detail, quota.resetEpochMs),
      quotaResetEpochMs: quota.resetEpochMs,
    };
  }
  if (
    status === 413 ||
    REQUEST_TOO_LARGE_CODES.has(parsed.code) ||
    REQUEST_TOO_LARGE_CODES.has(parsed.type)
  ) {
    const errorClass = matches(CONTEXT_WINDOW_NAMED_PATTERNS, haystack)
      ? "context_overflow"
      : "request_too_large";
    return { ...common, class: errorClass, retryable: false };
  }
  if (
    CONTEXT_CODES.has(parsed.code) ||
    CONTEXT_CODES.has(parsed.type) ||
    // A throttle that names a request size is about tokens per minute, not the context.
    (status !== 429 && matches(CONTEXT_PATTERNS, haystack))
  ) {
    return { ...common, class: "context_overflow", retryable: false };
  }
  if (eventRule) {
    return {
      ...common,
      class: eventRule.class,
      retryable: ruleRetryable(eventRule, retryAfterMs),
      ...(eventRule.failure !== undefined ? { failure: eventRule.failure } : {}),
      detail: detailWithPrefix(common.detail, eventRule.detailPrefix),
    };
  }
  if (readHeader(input.headers, "x-should-retry") === "true") {
    const errorClass = status === 429 ? "rate_limit" : status === 529 ? "overloaded" : "server";
    return { ...common, class: errorClass, retryable: true };
  }
  if (
    OVERLOAD_CODES.has(parsed.code) ||
    OVERLOAD_CODES.has(parsed.type) ||
    matches(OVERLOAD_PATTERNS, parsed.message || body)
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
  if (isRetryableNetworkError(input.error)) {
    return { ...common, class: "network", retryable: true };
  }
  if (input.error && typeof input.error === "object" && isTerminalNetworkError(input.error)) {
    return { ...common, class: "network", retryable: false };
  }
  return { ...common, class: "unknown", retryable: false };
}

function ruleRetryable(rule: ProviderWireRule, retryAfterMs: number | null): boolean {
  if (rule.retryWithinMs === undefined || retryAfterMs === null) return rule.retryable;
  return retryAfterMs <= rule.retryWithinMs;
}

export function formatProviderError(
  error: Pick<ProviderErrorClassification, "class" | "provider" | "model" | "detail">,
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

export function isRetryableNetworkError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (isTerminalNetworkError(error)) return false;
  // Byte silence is a connection-health failure: reconnecting on a fresh
  // socket can recover it, so it is never an "unknown" terminal class.
  // Content silence stays out of this predicate — whether it is a wedged
  // model (terminal) or a quiet provider (retryable) is a provider-level
  // decision owned by the retry classifier.
  if (error instanceof StreamSilenceError && error.scope === "byte") return true;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  if ((error as { name?: unknown }).name === "TimeoutError") return true;
  const message = messageFromError(error);
  if (message && matches(TRANSIENT_NETWORK_PATTERNS, message)) return true;
  return isRetryableNetworkError((error as { cause?: unknown }).cause);
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
  if (parsed.verificationUrl) return withVerificationLink(detail, parsed.verificationUrl);
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
}): { exhausted: boolean; resetEpochMs: number | null; failure?: RequestFailure } {
  const headers = input.input.headers;
  const unifiedStatus = readHeader(headers, "anthropic-ratelimit-unified-status");
  if (unifiedStatus === "rejected") {
    const resetSeconds = numericHeader(readHeader(headers, "anthropic-ratelimit-unified-reset"));
    const resetEpochMs = resetSeconds === null ? null : resetSeconds * 1000;
    const waitMs =
      input.retryAfterMs ?? (resetEpochMs === null ? null : Math.max(0, resetEpochMs - Date.now()));
    const shouldRetry = readHeader(headers, "x-should-retry");
    const soft = shouldRetry === "true" && waitMs !== null && waitMs <= RETRY_AFTER_TOO_LONG_MS;
    // Usage runs over into paid overage, or the window names no reset: the
    // account is throttled, not out of its plan.
    const overage =
      readHeader(headers, "anthropic-ratelimit-unified-overage-in-use") === "true" ||
      readHeader(headers, "anthropic-ratelimit-unified-overage-status") === "allowed";
    return {
      exhausted: !soft,
      resetEpochMs: soft ? null : (resetEpochMs ?? retryReset(input.retryAfterMs)),
      ...(overage || resetEpochMs === null ? { failure: "rate_limited" as const } : {}),
    };
  }

  const shouldRetry = readHeader(headers, "x-should-retry");
  if (input.status === 429 && shouldRetry === "false") {
    return {
      exhausted: true,
      resetEpochMs: retryReset(input.retryAfterMs),
      failure: longWaitFailure(input.retryAfterMs),
    };
  }
  const shortCapacityWindow =
    input.parsed.quotaId.includes("PerMinute") ||
    input.parsed.quotaId.includes("PerSecond") ||
    (input.parsed.retryDelayMs !== null && input.parsed.retryDelayMs <= 300_000);
  const dailyQuota =
    input.parsed.quotaId.includes("PerDay") || input.parsed.quotaId.includes("Daily");
  if (QUOTA_CODES.has(input.parsed.code) || QUOTA_CODES.has(input.parsed.type) || dailyQuota) {
    // A workspace whose credits ran out reports a usage limit, but no window resets it.
    const creditsSpent = /credits_depleted|^workspace_\w+_usage_limit_reached$/.test(
      readHeader(headers, "x-codex-rate-limit-reached-type") ?? "",
    );
    return {
      exhausted: !shortCapacityWindow || dailyQuota,
      resetEpochMs: input.parsed.resetEpochMs ?? retryReset(input.retryAfterMs),
      ...(creditsSpent ? { failure: "billing" as const } : {}),
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
    return {
      exhausted: true,
      resetEpochMs: Date.now() + input.retryAfterMs,
      failure: longWaitFailure(input.retryAfterMs),
    };
  }
  return { exhausted: false, resetEpochMs: null };
}

/** A wait of minutes is a throttle; one past several minutes is a usage window. */
function longWaitFailure(retryAfterMs: number | null): RequestFailure {
  return retryAfterMs !== null && retryAfterMs > USAGE_WINDOW_WAIT_MS
    ? "usage_limit"
    : "rate_limited";
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
  const text = formatResetTime(Math.floor(resetEpochMs / 1000));
  return text ? `${detail} — resets ${text}` : detail;
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
