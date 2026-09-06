import { providerEndpoint } from "@/devtools/config.ts";
import { usageFetchSignal } from "@/engine/providers/_shared/usage-fetch.ts";
import type { AnthropicRateLimitUsage } from "@/engine/providers/anthropic/usage.ts";
import {
  applyScopedQuotaWarnings,
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

export interface CodexCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface CodexSpendControl {
  reached: boolean;
  individualLimit?: {
    limit: string;
    used: string;
    remainingPercent: number;
    resetsAt: string | null;
  } | null;
}

export interface CodexUsage {
  primary?: CodexRateLimitUsage | null | undefined;
  secondary?: CodexRateLimitUsage | null | undefined;
  additional?: CodexAdditionalUsageLimit[] | undefined;
  credits?: CodexCredits | null | undefined;
  spendControl?: CodexSpendControl | null | undefined;
  planType?: string | null | undefined;
  rateLimitReachedType?: string | null | undefined;
}

const HEADER_PREFIX = "x-codex";
const RATE_LIMIT_EVENT = "codex.rate_limits";
const USAGE_URL = providerEndpoint("codex", "usage", "https://chatgpt.com/backend-api/wham/usage");
const REACHED_TYPES = new Set([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);

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
  const additional = parseAdditionalWireLimits(root.additional_rate_limits);
  const credits = parseCredits(root.credits);
  const spendControl = parseSpendControl(root.spend_control);
  const rateLimitReachedType = optionalReachedType(root, raw);
  if (
    primary === undefined &&
    secondary === undefined &&
    additional.length === 0 &&
    credits === undefined &&
    spendControl === undefined &&
    rateLimitReachedType === undefined
  ) {
    return null;
  }
  return {
    primary,
    secondary,
    additional,
    credits,
    spendControl,
    planType: nullableString(root.plan_type ?? raw.plan_type),
    rateLimitReachedType,
  };
}

export function parseCodexUsagePayload(value: unknown): CodexUsage | null {
  const root = objectValue(value);
  if (!root) return null;
  const rateLimit = objectValue(root.rate_limit);
  const primary = parsePayloadWindow(rateLimit?.primary_window);
  const secondary = parsePayloadWindow(rateLimit?.secondary_window);
  const additional = parseAdditionalLimits(root.additional_rate_limits);
  const credits = parseCredits(root.credits);
  const spendControl = parseSpendControl(root.spend_control);
  const rateLimitReachedType = optionalReachedType(root);
  if (
    primary === undefined &&
    secondary === undefined &&
    additional.length === 0 &&
    credits === undefined &&
    spendControl === undefined &&
    rateLimitReachedType === undefined
  ) {
    return null;
  }
  return {
    primary,
    secondary,
    additional,
    credits,
    spendControl,
    planType: nullableString(root.plan_type),
    rateLimitReachedType,
  };
}

export function parseCodexUsageHeaders(headers: Headers): CodexUsage | null {
  const primary = parseHeaderLimit(headers, `${HEADER_PREFIX}-primary`);
  const secondary = parseHeaderLimit(headers, `${HEADER_PREFIX}-secondary`);
  const additional = parseAdditionalHeaderLimits(headers);
  const credits = parseHeaderCredits(headers);
  const reachedHeader = headers.has(`${HEADER_PREFIX}-rate-limit-reached-type`)
    ? headerString(headers, `${HEADER_PREFIX}-rate-limit-reached-type`)
    : undefined;
  const rateLimitReachedType = normalizeReachedType(reachedHeader);
  if (
    primary === undefined &&
    secondary === undefined &&
    additional.length === 0 &&
    credits === undefined &&
    rateLimitReachedType === undefined
  ) {
    return null;
  }
  return {
    primary,
    secondary,
    additional,
    credits,
    planType: headerString(headers, `${HEADER_PREFIX}-plan-type`),
    rateLimitReachedType,
  };
}

export function codexUsageToSseFrame(usage: CodexUsage): Uint8Array {
  const body: Record<string, unknown> = {
    type: RATE_LIMIT_EVENT,
    rate_limits: wireRateLimits(usage),
  };
  if (usage.additional !== undefined)
    body.additional_rate_limits = usage.additional.map(wireAdditional);
  if (usage.credits !== undefined) body.credits = wireCredits(usage.credits);
  if (usage.spendControl !== undefined) body.spend_control = wireSpendControl(usage.spendControl);
  if (usage.planType) body.plan_type = usage.planType;
  if (usage.rateLimitReachedType) body.rate_limit_reached_type = usage.rateLimitReachedType;
  return new TextEncoder().encode(`event: ${RATE_LIMIT_EVENT}\ndata: ${JSON.stringify(body)}\n\n`);
}

function parseCredits(value: unknown): CodexCredits | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const obj = objectValue(value);
  if (!obj || typeof obj.has_credits !== "boolean" || typeof obj.unlimited !== "boolean") {
    return null;
  }
  return {
    hasCredits: obj.has_credits,
    unlimited: obj.unlimited,
    balance: nullableString(obj.balance),
  };
}

function parseSpendControl(value: unknown): CodexSpendControl | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const obj = objectValue(value);
  if (!obj || typeof obj.reached !== "boolean") return null;
  const individual = objectValue(obj.individual_limit);
  const individualLimit = individual
    ? {
        limit: nullableString(individual.limit) ?? "",
        used: nullableString(individual.used) ?? "",
        remainingPercent: nullableNumber(individual.remaining_percent) ?? 0,
        resetsAt: resetsAt(individual.reset_at),
      }
    : obj.individual_limit === null
      ? null
      : undefined;
  return {
    reached: obj.reached,
    ...(individualLimit !== undefined ? { individualLimit } : {}),
  };
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

function parseAdditionalWireLimits(value: unknown): CodexAdditionalUsageLimit[] {
  if (!Array.isArray(value)) return [];
  const out: CodexAdditionalUsageLimit[] = [];
  for (const item of value) {
    const obj = objectValue(item);
    if (!obj) continue;
    const primary = parseLimit(obj.primary);
    const secondary = parseLimit(obj.secondary);
    if (primary === undefined && secondary === undefined) continue;
    const id = nullableString(obj.id);
    const label = nullableString(obj.label) ?? id;
    if (!label) continue;
    out.push({ ...(id ? { id } : {}), label, primary, secondary });
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
      limitWindowSeconds === null
        ? nullableNumber(obj.window_minutes)
        : limitWindowSeconds > 0
          ? Math.ceil(limitWindowSeconds / 60)
          : null,
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

function parseAdditionalHeaderLimits(headers: Headers): CodexAdditionalUsageLimit[] {
  const prefixPattern = /^x-(.+)-primary-used-percent$/i;
  const ids = new Set<string>();
  for (const name of headers.keys()) {
    const match = name.match(prefixPattern);
    const id = match?.[1]?.toLowerCase().replace(/-/g, "_");
    if (id && id !== "codex") ids.add(id);
  }
  const additional: CodexAdditionalUsageLimit[] = [];
  for (const id of [...ids].sort()) {
    const headerId = id.replace(/_/g, "-");
    const prefix = `x-${headerId}`;
    const primary = parseHeaderLimit(headers, `${prefix}-primary`);
    const secondary = parseHeaderLimit(headers, `${prefix}-secondary`);
    if (primary === undefined && secondary === undefined) continue;
    const rawLabel = headerString(headers, `${prefix}-limit-name`) ?? id;
    additional.push({ id, label: displayLimitName(rawLabel), primary, secondary });
  }
  return additional;
}

function parseHeaderCredits(headers: Headers): CodexCredits | undefined {
  const hasCredits = headerBoolean(headers, `${HEADER_PREFIX}-credits-has-credits`);
  const unlimited = headerBoolean(headers, `${HEADER_PREFIX}-credits-unlimited`);
  if (hasCredits === null || unlimited === null) return undefined;
  return {
    hasCredits,
    unlimited,
    balance: headerString(headers, `${HEADER_PREFIX}-credits-balance`),
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

function wireRateLimits(usage: CodexUsage): Record<string, unknown> {
  const rateLimits: Record<string, unknown> = {};
  if (usage.primary !== undefined) rateLimits.primary = wireLimit(usage.primary);
  if (usage.secondary !== undefined) rateLimits.secondary = wireLimit(usage.secondary);
  return rateLimits;
}

function wireAdditional(limit: CodexAdditionalUsageLimit): Record<string, unknown> {
  return {
    ...(limit.id ? { id: limit.id } : {}),
    label: limit.label,
    ...(limit.primary !== undefined ? { primary: wireLimit(limit.primary) } : {}),
    ...(limit.secondary !== undefined ? { secondary: wireLimit(limit.secondary) } : {}),
  };
}

function wireCredits(credits: CodexCredits | null): Record<string, unknown> | null {
  if (credits === null) return null;
  return {
    has_credits: credits.hasCredits,
    unlimited: credits.unlimited,
    balance: credits.balance,
  };
}

function wireSpendControl(spendControl: CodexSpendControl | null): Record<string, unknown> | null {
  if (spendControl === null) return null;
  const individual = spendControl.individualLimit;
  return {
    reached: spendControl.reached,
    ...(individual === undefined
      ? {}
      : {
          individual_limit:
            individual === null
              ? null
              : {
                  limit: individual.limit,
                  used: individual.used,
                  remaining_percent: individual.remainingPercent,
                  reset_at: resetEpochSeconds(individual.resetsAt),
                },
        }),
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
  if (raw === null) return null;
  return normalizeReachedType(nullableString(objectValue(raw)?.type ?? raw));
}

function normalizeReachedType(value: string | null | undefined): string | undefined {
  return value !== null && value !== undefined && REACHED_TYPES.has(value) ? value : undefined;
}

function headerBoolean(headers: Headers, name: string): boolean | null {
  const value = headerString(headers, name);
  if (value === null) return null;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  return null;
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
 * Codex stores separate global primary/secondary windows plus one scope per
 * additional metered limit. A recognized Spark limit applies only to Spark;
 * unknown additional limits remain informational. Percentages are already on
 * the provider's 0..100 scale. A non-null account/workspace reached reason or
 * reached spend control adds one account-global exhaustion scope; it never
 * selects or overrides an individual rolling window.
 */
export function applyCodexQuotaWarning(usage: CodexUsage | null): void {
  if (!usage) {
    applyScopedQuotaWarnings("codex", []);
    return;
  }

  const scopes: ScopedQuotaCandidate[] = [];
  pushGlobalScope(scopes, "primary", usage.primary);
  pushGlobalScope(scopes, "secondary", usage.secondary);
  if (codexAccountExhausted(usage)) {
    scopes.push({
      scopeKey: "account",
      displayLabel: "Codex account limit",
      applicability: { type: "global" },
      label: "Codex account limit",
      utilization: 100,
      resetsAt: null,
      trackingStatus: "untracked",
      signal: { exhausted: true, label: "Codex account limit" },
    });
  }
  for (const [index, additional] of (usage.additional ?? []).entries()) {
    pushAdditionalScope(scopes, additional, additional.primary, index, "primary");
    pushAdditionalScope(scopes, additional, additional.secondary, index, "secondary");
  }

  applyScopedQuotaWarnings("codex", scopes);
}

function codexAccountExhausted(usage: CodexUsage): boolean {
  return (
    usage.spendControl?.reached === true ||
    (usage.rateLimitReachedType !== null && usage.rateLimitReachedType !== undefined)
  );
}

function pushGlobalScope(
  out: ScopedQuotaCandidate[],
  kind: "primary" | "secondary",
  limit: CodexRateLimitUsage | null | undefined,
): void {
  if (!limit || limit.utilization === null || limit.utilization === undefined) return;
  const label = codexWindowLabel(limit, kind);
  out.push({
    scopeKey: kind,
    displayLabel: label,
    applicability: { type: "global" },
    label,
    utilizationPct: limit.utilization,
    utilization: limit.utilization,
    resetsAt: limit.resetsAt,
    trackingStatus: "tracked",
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
    utilizationPct: limit.utilization,
    utilization: limit.utilization,
    resetsAt: limit.resetsAt,
    trackingStatus: "tracked",
  });
}

function codexWindowLabel(
  limit: CodexRateLimitUsage | null | undefined,
  kind: "primary" | "secondary",
): string {
  const minutes = limit?.windowMinutes ?? null;
  if (minutes === null || minutes === undefined) return kind;
  if (approximately(minutes, 5 * 60)) return "5h";
  if (approximately(minutes, 24 * 60)) return "daily";
  if (approximately(minutes, 7 * 24 * 60)) return "weekly";
  if (approximately(minutes, 30 * 24 * 60)) return "monthly";
  if (approximately(minutes, 365 * 24 * 60)) return "annual";
  return kind;
}

function approximately(value: number, expected: number): boolean {
  return value >= expected * 0.95 && value <= expected * 1.05;
}
