import { usageFetchSignal } from "@/engine/providers/_shared/usage-fetch.ts";
import {
  defaultLimits,
  type RateLimitWindow,
  type RawUtilization,
  setUsageLimits,
  type UsageLimitState,
} from "@/engine/session/usage/limits.ts";
import {
  applyScopedQuotaWarnings,
  type ScopedQuotaCandidate,
} from "@/engine/session/usage/quota-warning.ts";
import {
  normalizeEpochMs,
  normalizeUtilizationPct,
} from "@/engine/session/usage/routing-usage-normalize.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import { type AnthropicTokens, loadFor } from "@/kernel/storage/credentials.ts";
import { API_USAGE_URL, OAUTH_BETA, uaClaudeCode } from "./_infra/fingerprint.ts";
import { authorizationHeader } from "./auth.ts";

export interface AnthropicRateLimitUsage {
  utilization: number | null;
  resetsAt: string | null;
}

interface AnthropicExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  utilization: number | null;
  currency?: string | null | undefined;
  disabledReason?: string | null | undefined;
}

interface AnthropicModelScopedUsage extends AnthropicRateLimitUsage {
  displayName: string;
}

export interface AnthropicUsage {
  fiveHour?: AnthropicRateLimitUsage | null | undefined;
  sevenDay?: AnthropicRateLimitUsage | null | undefined;
  sevenDayOauthApps?: AnthropicRateLimitUsage | null | undefined;
  sevenDayOpus?: AnthropicRateLimitUsage | null | undefined;
  sevenDaySonnet?: AnthropicRateLimitUsage | null | undefined;
  cinderCove?: AnthropicRateLimitUsage | null | undefined;
  modelScoped?: AnthropicModelScopedUsage[] | undefined;
  sevenDayFable?: AnthropicRateLimitUsage | null | undefined;
  extraUsage?: AnthropicExtraUsage | null | undefined;
}

const ANTHROPIC_USAGE_WINDOWS = [
  ["five_hour", "fiveHour"],
  ["seven_day", "sevenDay"],
  ["seven_day_fable", "sevenDayFable"],
] as const satisfies readonly (readonly [RateLimitWindow, keyof AnthropicUsage])[];

interface AnthropicRoutingCandidate {
  window: RateLimitWindow;
  utilizationRatio: number;
  resetsAtSeconds?: number | undefined;
}

export async function fetchAnthropicUsage(): Promise<AnthropicUsage | null> {
  const tokens = await loadFor("anthropic");
  if (!tokens || !hasProfileScope(tokens)) return null;
  const auth = await authorizationHeader();
  const resp = await fetch(API_USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: auth,
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "User-Agent": uaClaudeCode(),
      "anthropic-beta": OAUTH_BETA,
    },
    signal: usageFetchSignal(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${truncateEllipsis(text, 240)}`);
  }
  return parseAnthropicUsage((await resp.json()) as Record<string, unknown>);
}

export function applyAnthropicUsageLimits(usage: AnthropicUsage | null): void {
  if (usage === null) return;
  const raw: RawUtilization = {};
  const candidates: AnthropicRoutingCandidate[] = [];
  for (const [window, key] of ANTHROPIC_USAGE_WINDOWS) {
    const limit = usage[key];
    if (!limit || limit.utilization === null) continue;
    const utilizationPct = normalizeUtilizationPct(limit.utilization);
    if (utilizationPct === undefined) continue;
    const utilizationRatio = utilizationPct / 100;
    const resetsAtSeconds = epochSeconds(limit.resetsAt);
    if (resetsAtSeconds !== undefined) {
      raw[window] = { utilization: utilizationRatio, resetsAt: resetsAtSeconds };
    }
    candidates.push({
      window,
      utilizationRatio,
      ...(resetsAtSeconds !== undefined ? { resetsAtSeconds } : {}),
    });
  }
  // The Fable-scoped weekly bucket is a per-model limit: it must gate ONLY the
  // Fable model (see providerRouteability's family matching), never the whole
  // Anthropic provider. Keep it in `raw` for the usage panel, but exclude it
  // from the account-wide state that drives the legacy limit banner —
  // otherwise a maxed Fable week wrongly blocks opus/sonnet and shows a Fable
  // banner while the active model isn't Fable.
  const globalCandidate = worstAnthropicCandidate(
    candidates.filter((entry) => entry.window !== "seven_day_fable"),
  );
  // setUsageLimits preserves raw/limits (getRawUtilization/getCurrentLimits)
  // and writes the header-compat "global" scope; the full per-window/family
  // scope replacement below then overwrites it atomically with the complete
  // fetched breakdown (five_hour, seven_day, overage, seven_day_fable).
  setUsageLimits(
    raw,
    globalCandidate ? usageLimitStateFromCandidate(globalCandidate) : defaultLimits(),
    { emit: false },
  );

  const scopes: ScopedQuotaCandidate[] = candidates.map((candidate) =>
    anthropicScopeCandidate(candidate),
  );
  const extraUtilization = usage.extraUsage?.utilization;
  if (extraUtilization !== null && extraUtilization !== undefined) {
    scopes.push(anthropicOverageScopeCandidate(extraUtilization));
  }
  applyScopedQuotaWarnings("anthropic", scopes);
}

function anthropicScopeCandidate(candidate: AnthropicRoutingCandidate): ScopedQuotaCandidate {
  const isFable = candidate.window === "seven_day_fable";
  const label = anthropicWindowLabel(candidate.window);
  return {
    scopeKey: candidate.window,
    displayLabel: label,
    applicability: isFable ? { type: "family", id: "fable" } : { type: "global" },
    label,
    utilization: candidate.utilizationRatio * 100,
    resetsAt: candidate.resetsAtSeconds ?? null,
    trackingStatus: "tracked",
  };
}

function anthropicOverageScopeCandidate(utilization: number): ScopedQuotaCandidate {
  const utilizationPct = normalizeUtilizationPct(utilization) ?? 0;
  const label = "Anthropic extra usage limit";
  return {
    scopeKey: "overage",
    displayLabel: label,
    applicability: { type: "global" },
    label,
    utilization: utilizationPct,
    resetsAt: null,
    trackingStatus: "tracked",
  };
}

function anthropicWindowLabel(window: RateLimitWindow): string {
  switch (window) {
    case "five_hour":
      return "Anthropic session limit";
    case "seven_day":
      return "Anthropic weekly limit";
    case "seven_day_fable":
      return "Anthropic Fable limit";
    case "overage":
      return "Anthropic extra usage limit";
    default:
      return "Anthropic usage limit";
  }
}

function hasProfileScope(tokens: AnthropicTokens): boolean {
  return (
    tokens.scopes?.includes("user:inference") === true && tokens.scopes.includes("user:profile")
  );
}

const FABLE_DISPLAY_NAME = "fable";

const FLAT_USAGE_WINDOWS = [
  ["five_hour", "fiveHour"],
  ["seven_day", "sevenDay"],
  ["seven_day_oauth_apps", "sevenDayOauthApps"],
  ["seven_day_opus", "sevenDayOpus"],
  ["seven_day_sonnet", "sevenDaySonnet"],
  ["cinder_cove", "cinderCove"],
] as const satisfies readonly (readonly [string, keyof AnthropicUsage])[];

// Claude Code's current response contract retains the named top-level windows
// and adds a `limits` array for session/weekly and server-supplied model scopes.
// Prefer limits[] for overlapping session/week rows, while preserving the
// named windows and every valid weekly_scoped row for explicit usage surfaces.
export function parseAnthropicUsage(data: Record<string, unknown>): AnthropicUsage {
  const usage: AnthropicUsage = { extraUsage: parseExtraUsage(data.extra_usage) };
  for (const [wireKey, usageKey] of FLAT_USAGE_WINDOWS) {
    if (!(wireKey in data)) continue;
    usage[usageKey] = parseRateLimitUsage(data[wireKey]);
  }

  const modelScoped: AnthropicModelScopedUsage[] = [];
  const limits = Array.isArray(data.limits) ? (data.limits as unknown[]) : [];
  for (const entry of limits) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const limit = parseLimitEntry(row);
    if (!limit) continue;
    if (row.kind === "session") usage.fiveHour = limit;
    else if (row.kind === "weekly_all") usage.sevenDay = limit;
    else if (row.kind === "weekly_scoped") {
      const displayName = scopedModelDisplayName(row);
      if (!displayName) continue;
      modelScoped.push({ displayName, ...limit });
      if (displayName.toLowerCase() === FABLE_DISPLAY_NAME) usage.sevenDayFable = limit;
    }
  }
  if (modelScoped.length > 0) usage.modelScoped = modelScoped;
  return usage;
}

function parseRateLimitUsage(value: unknown): AnthropicRateLimitUsage | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const utilization = nullableNumber(input.utilization);
  const resetsAt = usageResetIso(input.resets_at);
  if (utilization === null && resetsAt === null) return null;
  return { utilization, resetsAt };
}

function parseLimitEntry(row: Record<string, unknown>): AnthropicRateLimitUsage | null {
  const utilization = nullableNumber(row.percent);
  const resetsAt = usageResetIso(row.resets_at);
  if (utilization === null && resetsAt === null) return null;
  return { utilization, resetsAt };
}

function usageResetIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    try {
      return new Date(value * 1000).toISOString();
    } catch {
      return null;
    }
  }
  return nullableString(value);
}

function scopedModelDisplayName(row: Record<string, unknown>): string | null {
  const scope = row.scope;
  if (!scope || typeof scope !== "object") return null;
  const model = (scope as Record<string, unknown>).model;
  if (!model || typeof model !== "object") return null;
  const name = (model as Record<string, unknown>).display_name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

function parseExtraUsage(value: unknown): AnthropicExtraUsage | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  return {
    isEnabled: input.is_enabled === true,
    monthlyLimit: nullableNumber(input.monthly_limit),
    usedCredits: nullableNumber(input.used_credits),
    utilization: nullableNumber(input.utilization),
    ...(input.currency !== undefined ? { currency: nullableString(input.currency) } : {}),
    ...(input.disabled_reason !== undefined
      ? { disabledReason: nullableString(input.disabled_reason) }
      : {}),
  };
}

function worstAnthropicCandidate(
  candidates: AnthropicRoutingCandidate[],
): AnthropicRoutingCandidate | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a.utilizationRatio >= b.utilizationRatio ? a : b));
}

function usageLimitStateFromCandidate(candidate: AnthropicRoutingCandidate): UsageLimitState {
  return {
    status: usageQuotaStatus(candidate.utilizationRatio),
    unifiedRateLimitFallbackAvailable: false,
    rateLimitType: candidate.window,
    utilization: candidate.utilizationRatio,
    ...(candidate.resetsAtSeconds !== undefined ? { resetsAt: candidate.resetsAtSeconds } : {}),
    isOverageActive: false,
  };
}

function usageQuotaStatus(utilizationRatio: number): UsageLimitState["status"] {
  if (utilizationRatio >= 1) return "rejected";
  if (utilizationRatio >= 0.7) return "allowed_warning";
  return "allowed";
}

function epochSeconds(value: string | null): number | undefined {
  const epochMs = normalizeEpochMs(value);
  return epochMs === undefined ? undefined : Math.floor(epochMs / 1000);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
