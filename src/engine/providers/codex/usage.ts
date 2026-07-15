import { providerEndpoint } from "@/devtools/config.ts";
import { usageFetchSignal } from "@/engine/providers/_shared/usage-fetch.ts";
import type { AnthropicRateLimitUsage } from "@/engine/providers/anthropic/usage.ts";
import {
  applyScopedQuotaWarnings,
  type ExplicitQuotaSignal,
  type ScopedQuotaCandidate,
} from "@/engine/session/usage/quota-warning.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import { currentTokens } from "./auth.ts";
import { userAgent } from "./fingerprint.ts";

export interface CodexRateLimitUsage extends AnthropicRateLimitUsage {
  windowMinutes?: number | null | undefined;
}

export interface CodexAdditionalUsageLimit {
  id?: string | undefined;
  label: string;
  primary?: CodexRateLimitUsage | null | undefined;
  secondary?: CodexRateLimitUsage | null | undefined;
}

export interface CodexUsage {
  primary?: CodexRateLimitUsage | null | undefined;
  secondary?: CodexRateLimitUsage | null | undefined;
  additional?: CodexAdditionalUsageLimit[] | undefined;
  planType?: string | null | undefined;
  rateLimitReachedType?: string | null | undefined;
}

const HEADER_PREFIX = "x-codex";
const RATE_LIMIT_EVENT = "codex.rate_limits";
const USAGE_URL = providerEndpoint("codex", "usage", "https://chatgpt.com/backend-api/wham/usage");

export async function fetchCodexUsage(): Promise<CodexUsage | null> {
  const tokens = await currentTokens();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokens.accessToken}`,
    Accept: "application/json",
    "User-Agent": userAgent(),
  };
  if (tokens.accountId) headers["ChatGPT-Account-Id"] = tokens.accountId;
  const resp = await fetch(USAGE_URL, { method: "GET", headers, signal: usageFetchSignal() });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${truncateEllipsis(text, 240)}`);
  }
  return parseCodexUsagePayload((await resp.json()) as Record<string, unknown>);
}

export function parseCodexUsage(value: unknown): CodexUsage | null {
  const root = objectValue(value);
  if (!root) return null;
  const raw = objectValue(root.rate_limits) ?? root;
  const primary = parseLimit(raw.primary);
  const secondary = parseLimit(raw.secondary);
  if (primary === undefined && secondary === undefined) return null;
  return {
    primary,
    secondary,
    planType: nullableString(root.plan_type ?? raw.plan_type),
    rateLimitReachedType: optionalReachedType(root, raw),
  };
}

export function parseCodexUsagePayload(value: unknown): CodexUsage | null {
  const root = objectValue(value);
  if (!root) return null;
  const rateLimit = objectValue(root.rate_limit);
  const primary = parsePayloadWindow(rateLimit?.primary_window);
  const secondary = parsePayloadWindow(rateLimit?.secondary_window);
  const additional = parseAdditionalLimits(root.additional_rate_limits);
  if (primary === undefined && secondary === undefined && additional.length === 0) return null;
  return {
    primary,
    secondary,
    additional,
    planType: nullableString(root.plan_type),
    rateLimitReachedType: optionalReachedType(root),
  };
}

export function parseCodexUsageHeaders(headers: Headers): CodexUsage | null {
  const primary = parseHeaderLimit(headers, `${HEADER_PREFIX}-primary`);
  const secondary = parseHeaderLimit(headers, `${HEADER_PREFIX}-secondary`);
  if (primary === undefined && secondary === undefined) return null;
  return {
    primary,
    secondary,
    planType: headerString(headers, `${HEADER_PREFIX}-plan-type`),
    rateLimitReachedType: headers.has(`${HEADER_PREFIX}-rate-limit-reached-type`)
      ? headerString(headers, `${HEADER_PREFIX}-rate-limit-reached-type`)
      : undefined,
  };
}

export function codexUsageToSseFrame(usage: CodexUsage): Uint8Array {
  const rateLimits: Record<string, unknown> = {};
  if (usage.primary !== undefined) rateLimits.primary = wireLimit(usage.primary);
  if (usage.secondary !== undefined) rateLimits.secondary = wireLimit(usage.secondary);
  const body: Record<string, unknown> = {
    type: RATE_LIMIT_EVENT,
    rate_limits: rateLimits,
  };
  if (usage.planType) body.plan_type = usage.planType;
  if (usage.rateLimitReachedType) body.rate_limit_reached_type = usage.rateLimitReachedType;
  return new TextEncoder().encode(`event: ${RATE_LIMIT_EVENT}\ndata: ${JSON.stringify(body)}\n\n`);
}

function parseAdditionalLimits(value: unknown): CodexAdditionalUsageLimit[] {
  if (!Array.isArray(value)) return [];
  const out: CodexAdditionalUsageLimit[] = [];
  for (const item of value) {
    const obj = objectValue(item);
    if (!obj) continue;
    const rateLimit = objectValue(obj.rate_limit);
    const primary = parsePayloadWindow(rateLimit?.primary_window);
    const secondary = parsePayloadWindow(rateLimit?.secondary_window);
    if (primary === undefined && secondary === undefined) continue;
    const rawId = nullableString(obj.metered_feature) ?? nullableString(obj.limit_name);
    const rawLabel = nullableString(obj.limit_name) ?? rawId ?? "Additional";
    out.push({
      ...(rawId ? { id: rawId } : {}),
      label: displayLimitName(rawLabel),
      primary,
      secondary,
    });
  }
  return out;
}

function parsePayloadWindow(value: unknown): CodexRateLimitUsage | undefined {
  const obj = objectValue(value);
  if (!obj) return undefined;
  const utilization = nullableNumber(obj.used_percent);
  if (utilization === null) return undefined;
  const limitWindowSeconds = nullableNumber(obj.limit_window_seconds);
  return {
    utilization,
    windowMinutes:
      limitWindowSeconds === null ? nullableNumber(obj.window_minutes) : limitWindowSeconds / 60,
    resetsAt: resetsAt(obj.reset_at),
  };
}

function parseLimit(value: unknown): CodexRateLimitUsage | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const obj = objectValue(value);
  if (!obj) return null;
  return {
    utilization: nullableNumber(obj.used_percent ?? obj.used_percentage ?? obj.utilization),
    windowMinutes: nullableNumber(obj.window_minutes),
    resetsAt: resetsAt(obj.resets_at ?? obj.reset_at ?? obj.reset),
  };
}

function parseHeaderLimit(headers: Headers, prefix: string): CodexRateLimitUsage | undefined {
  const utilization = headerNumber(headers, `${prefix}-used-percent`);
  const windowMinutes = headerNumber(headers, `${prefix}-window-minutes`);
  const reset = headerString(headers, `${prefix}-reset-at`);
  if (utilization === null) return undefined;
  if (utilization === 0 && (windowMinutes === null || windowMinutes === 0) && reset === null) {
    return undefined;
  }
  return {
    utilization,
    windowMinutes,
    resetsAt: resetsAt(reset),
  };
}

function wireLimit(limit: CodexRateLimitUsage | null | undefined): unknown {
  if (limit === undefined) return undefined;
  if (limit === null) return null;
  return {
    used_percent: limit.utilization,
    window_minutes: limit.windowMinutes ?? null,
    reset_at: resetEpochSeconds(limit.resetsAt),
  };
}

function resetsAt(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return new Date(numeric * 1000).toISOString();
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  return null;
}

function resetEpochSeconds(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return Math.floor(parsed / 1000);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function optionalReachedType(
  root: Record<string, unknown>,
  fallback?: Record<string, unknown>,
): string | null | undefined {
  const source = Object.hasOwn(root, "rate_limit_reached_type")
    ? root
    : fallback && Object.hasOwn(fallback, "rate_limit_reached_type")
      ? fallback
      : null;
  if (source === null) return undefined;
  const raw = source.rate_limit_reached_type;
  return nullableString(objectValue(raw)?.type ?? raw);
}

function headerNumber(headers: Headers, name: string): number | null {
  const value = headerString(headers, name);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function headerString(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  return value && value.trim().length > 0 ? value : null;
}

function displayLimitName(value: string): string {
  const normalized = value
    .replace(/[_ ]+/g, "-")
    .replace(/^gpt-(\d+)-(\d+)/i, "GPT-$1.$2")
    .replace(/^gpt-/i, "GPT-");
  return normalized
    .split("-")
    .filter(Boolean)
    .map((part) => {
      if (/^gpt$/i.test(part)) return "GPT";
      if (/^\d+(\.\d+)?$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("-");
}

/**
 * Codex stores separate global "primary"/"secondary" scopes plus one scope
 * per additional limit/window (Spark family when its normalized
 * `${id} ${label}` names it, informational otherwise so it stays visible
 * without ever blocking an unrelated model). `rateLimitReachedType` is the
 * provider's own exhaustion verdict, but it only ever targets the two GLOBAL
 * windows: a non-null value explicitly exhausts exactly that window (the
 * other global window derives normally), and an explicit null (the property
 * is present but not set) is an explicit not-reached that beats a rounded
 * 100% for BOTH global windows. Additional scopes never receive this signal —
 * a Spark window at raw 100% still blocks Spark regardless of the account's
 * primary/secondary state. When the usage object omits the property
 * entirely (undefined), every window — global and additional — derives
 * exhaustion from its own raw percentage.
 */
export function applyCodexQuotaWarning(usage: CodexUsage | null): void {
  if (!usage) {
    applyScopedQuotaWarnings("codex", []);
    return;
  }

  const reachedProvided = usage.rateLimitReachedType !== undefined;
  const reached = usage.rateLimitReachedType ?? null;

  const scopes: ScopedQuotaCandidate[] = [];
  pushGlobalScope(scopes, "primary", usage.primary, reachedProvided, reached);
  pushGlobalScope(scopes, "secondary", usage.secondary, reachedProvided, reached);
  if (
    reachedProvided &&
    reached !== null &&
    !reached.toLowerCase().includes("primary") &&
    !reached.toLowerCase().includes("secondary")
  ) {
    scopes.push({
      scopeKey: "rate-limit-reached",
      displayLabel: "Codex rate limit",
      applicability: { type: "global" },
      label: "Codex rate limit",
      utilization: 100,
      resetsAt: null,
      trackingStatus: "untracked",
      signal: { exhausted: true, label: "Codex rate limit" },
    });
  }
  for (const [index, additional] of (usage.additional ?? []).entries()) {
    pushAdditionalScope(scopes, additional, additional.primary, index, "primary");
    pushAdditionalScope(scopes, additional, additional.secondary, index, "secondary");
  }

  applyScopedQuotaWarnings("codex", scopes);
}

function pushGlobalScope(
  out: ScopedQuotaCandidate[],
  kind: "primary" | "secondary",
  limit: CodexRateLimitUsage | null | undefined,
  reachedProvided: boolean,
  reached: string | null,
): void {
  if (!limit || limit.utilization === null || limit.utilization === undefined) return;
  const label = codexWindowLabel(limit, kind);
  const matchesThisWindow = reached?.toLowerCase().includes(kind) === true;
  const signal: ExplicitQuotaSignal | undefined = !reachedProvided
    ? undefined
    : reached === null
      ? { exhausted: false }
      : matchesThisWindow
        ? { exhausted: true, label, resetsAt: limit.resetsAt ?? null }
        : undefined;
  out.push({
    scopeKey: kind,
    displayLabel: label,
    applicability: { type: "global" },
    label,
    utilization: limit.utilization,
    resetsAt: limit.resetsAt,
    trackingStatus: "tracked",
    ...(signal !== undefined ? { signal } : {}),
  });
}

function pushAdditionalScope(
  out: ScopedQuotaCandidate[],
  additional: CodexAdditionalUsageLimit,
  limit: CodexRateLimitUsage | null | undefined,
  index: number,
  kind: "primary" | "secondary",
): void {
  if (!limit || limit.utilization === null || limit.utilization === undefined) return;
  const normalized = `${additional.id ?? ""} ${additional.label}`.toLowerCase();
  const isSpark = normalized.includes("spark");
  out.push({
    scopeKey: `additional-${index}-${kind}`,
    displayLabel: additional.label,
    applicability: isSpark ? { type: "family", id: "spark" } : { type: "informational" },
    label: additional.label,
    utilization: limit.utilization,
    resetsAt: limit.resetsAt,
    trackingStatus: "tracked",
    // No signal: additional scopes never receive the wire-level reached-type override.
  });
}

function codexWindowLabel(
  limit: CodexRateLimitUsage | null | undefined,
  kind: "primary" | "secondary",
): string {
  const minutes = limit?.windowMinutes ?? null;
  if (minutes !== null && minutes !== undefined) {
    // Codex plan surface is weekly-only; short windows still map to weekly so
    // statusline never says primary/session for this provider.
    if (minutes <= 1440) return "weekly";
    return "weekly";
  }
  void kind;
  // Wire field names stay primary/secondary internally; UI text never does.
  return "weekly";
}
