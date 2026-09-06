import {
  type QuotaStatus,
  type RateLimitWindow,
  type RawUtilization,
  setUsageLimits,
  type UsageLimitState,
} from "@/engine/session/usage/limits.ts";
import { isQuotaStatus } from "@/engine/session/usage/routing-usage-normalize.ts";

const WINDOW_HEADERS: readonly [RateLimitWindow, string][] = [
  ["five_hour", "5h"],
  ["seven_day", "7d"],
  ["overage", "overage"],
];

const EARLY_WARNING_CONFIGS: readonly {
  rateLimitType: RateLimitWindow;
  claimAbbrev: "5h" | "7d";
  windowSeconds: number;
  thresholds: readonly { utilization: number; timePct: number }[];
}[] = [
  {
    rateLimitType: "five_hour",
    claimAbbrev: "5h",
    windowSeconds: 5 * 60 * 60,
    thresholds: [{ utilization: 0.9, timePct: 0.72 }],
  },
  {
    rateLimitType: "seven_day",
    claimAbbrev: "7d",
    windowSeconds: 7 * 24 * 60 * 60,
    thresholds: [
      { utilization: 0.75, timePct: 0.6 },
      { utilization: 0.5, timePct: 0.35 },
      { utilization: 0.25, timePct: 0.15 },
    ],
  },
];

export function ingestAnthropicHeaders(headers: Headers): void {
  const hasHeaders = [...headers.keys()].some((key) =>
    key.startsWith("anthropic-ratelimit-unified-"),
  );
  if (!hasHeaders) return;

  setUsageLimits(parseRawUtilization(headers), computeLimits(headers));
}

function parseRawUtilization(headers: Headers): RawUtilization {
  const next: RawUtilization = {};
  for (const [window, abbrev] of WINDOW_HEADERS) {
    const utilization = parseNumber(
      headers.get(`anthropic-ratelimit-unified-${abbrev}-utilization`),
    );
    const resetsAt = parseNumber(headers.get(`anthropic-ratelimit-unified-${abbrev}-reset`));
    if (utilization !== undefined && resetsAt !== undefined) {
      next[window] = { utilization, resetsAt };
    }
  }
  return next;
}

function computeLimits(headers: Headers): UsageLimitState {
  const status = parseStatus(headers.get("anthropic-ratelimit-unified-status")) ?? "allowed";
  const unifiedRateLimitFallbackAvailable =
    headers.get("anthropic-ratelimit-unified-fallback") === "available";
  const resetsAt = parseNumber(headers.get("anthropic-ratelimit-unified-reset"));
  const rateLimitType = parseRateLimitType(
    headers.get("anthropic-ratelimit-unified-representative-claim"),
  );
  const overageStatus = parseStatus(headers.get("anthropic-ratelimit-unified-overage-status"));
  const overageResetsAt = parseNumber(headers.get("anthropic-ratelimit-unified-overage-reset"));
  const overageDisabledReason =
    headers.get("anthropic-ratelimit-unified-overage-disabled-reason") ?? undefined;
  const isOverageActive =
    status === "rejected" && (overageStatus === "allowed" || overageStatus === "allowed_warning");

  if (status === "allowed" || status === "allowed_warning") {
    const earlyWarning = earlyWarningFromHeaders(headers, unifiedRateLimitFallbackAvailable);
    if (earlyWarning) return mergeOverageState(earlyWarning, overageStatus, overageResetsAt);
    return {
      status: "allowed",
      unifiedRateLimitFallbackAvailable,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(rateLimitType !== undefined ? { rateLimitType } : {}),
      ...(overageStatus !== undefined ? { overageStatus } : {}),
      ...(overageResetsAt !== undefined ? { overageResetsAt } : {}),
      ...(overageDisabledReason !== undefined ? { overageDisabledReason } : {}),
      isOverageActive: false,
    };
  }

  return {
    status,
    unifiedRateLimitFallbackAvailable,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(rateLimitType !== undefined ? { rateLimitType } : {}),
    ...(overageStatus !== undefined ? { overageStatus } : {}),
    ...(overageResetsAt !== undefined ? { overageResetsAt } : {}),
    ...(overageDisabledReason !== undefined ? { overageDisabledReason } : {}),
    isOverageActive,
  };
}

function mergeOverageState(
  state: UsageLimitState,
  overageStatus: QuotaStatus | undefined,
  overageResetsAt: number | undefined,
): UsageLimitState {
  return {
    ...state,
    ...(overageStatus !== undefined ? { overageStatus } : {}),
    ...(overageResetsAt !== undefined ? { overageResetsAt } : {}),
  };
}

function earlyWarningFromHeaders(
  headers: Headers,
  unifiedRateLimitFallbackAvailable: boolean,
): UsageLimitState | null {
  for (const [rateLimitType, claimAbbrev] of WINDOW_HEADERS) {
    const surpassedThreshold = parseNumber(
      headers.get(`anthropic-ratelimit-unified-${claimAbbrev}-surpassed-threshold`),
    );
    if (surpassedThreshold === undefined) continue;
    const utilization = parseNumber(
      headers.get(`anthropic-ratelimit-unified-${claimAbbrev}-utilization`),
    );
    const resetsAt = parseNumber(headers.get(`anthropic-ratelimit-unified-${claimAbbrev}-reset`));
    return {
      status: "allowed_warning",
      unifiedRateLimitFallbackAvailable,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      rateLimitType,
      ...(utilization !== undefined ? { utilization } : {}),
      isOverageActive: false,
      surpassedThreshold,
    };
  }

  for (const config of EARLY_WARNING_CONFIGS) {
    const warning = timeRelativeEarlyWarning(headers, config, unifiedRateLimitFallbackAvailable);
    if (warning) return warning;
  }

  return null;
}

function timeRelativeEarlyWarning(
  headers: Headers,
  config: (typeof EARLY_WARNING_CONFIGS)[number],
  unifiedRateLimitFallbackAvailable: boolean,
): UsageLimitState | null {
  const utilization = parseNumber(
    headers.get(`anthropic-ratelimit-unified-${config.claimAbbrev}-utilization`),
  );
  const resetsAt = parseNumber(
    headers.get(`anthropic-ratelimit-unified-${config.claimAbbrev}-reset`),
  );
  if (utilization === undefined || resetsAt === undefined) return null;
  const timeProgress = computeTimeProgress(resetsAt, config.windowSeconds);
  const shouldWarn = config.thresholds.some(
    (threshold) => utilization >= threshold.utilization && timeProgress <= threshold.timePct,
  );
  if (!shouldWarn) return null;
  return {
    status: "allowed_warning",
    unifiedRateLimitFallbackAvailable,
    resetsAt,
    rateLimitType: config.rateLimitType,
    utilization,
    isOverageActive: false,
  };
}

function computeTimeProgress(resetsAt: number, windowSeconds: number): number {
  const nowSeconds = Date.now() / 1000;
  const windowStart = resetsAt - windowSeconds;
  const elapsed = nowSeconds - windowStart;
  return Math.max(0, Math.min(1, elapsed / windowSeconds));
}

function parseNumber(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseStatus(value: string | null): QuotaStatus | undefined {
  return isQuotaStatus(value) ? value : undefined;
}

function parseRateLimitType(value: string | null): RateLimitWindow | undefined {
  return WINDOW_HEADERS.some(([window]) => window === value)
    ? (value as RateLimitWindow)
    : undefined;
}
