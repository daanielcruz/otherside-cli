import type { ProviderId, ProviderModelRoute } from "@/kernel/std/types/provider-ids.ts";

export type RateLimitWindow = "five_hour" | "seven_day" | "seven_day_fable" | "overage";
export const QUOTA_STATUSES = ["allowed", "allowed_warning", "rejected"] as const;
export type QuotaStatus = (typeof QUOTA_STATUSES)[number];

export interface WindowUtilizationReading {
  utilization: number;
  resetsAt: number;
}

export type RawUtilization = Partial<Record<RateLimitWindow, WindowUtilizationReading>>;

export interface UsageLimitState {
  status: QuotaStatus;
  unifiedRateLimitFallbackAvailable: boolean;
  resetsAt?: number | undefined;
  rateLimitType?: RateLimitWindow | undefined;
  utilization?: number | undefined;
  overageStatus?: QuotaStatus | undefined;
  overageResetsAt?: number | undefined;
  overageDisabledReason?: string | undefined;
  isOverageActive: boolean;
  surpassedThreshold?: number | undefined;
}

export interface UsageWarning {
  message: string;
  severity: "warning" | "error";
}

export const ROUTING_TRACKING_STATUSES = ["tracked", "partial", "untracked", "unknown"] as const;
export type RoutingTrackingStatus = (typeof ROUTING_TRACKING_STATUSES)[number];

export const ROUTING_BALANCE_STATUSES = ["available", "exhausted", "unknown"] as const;
export type RoutingBalanceStatus = (typeof ROUTING_BALANCE_STATUSES)[number];

export interface RoutingUsageState {
  trackingStatus: RoutingTrackingStatus;
  utilizationPct?: number | undefined;
  resetsAtEpochMs?: number | undefined;
  observedAtEpochMs: number;
  balanceStatus: RoutingBalanceStatus;
}

/**
 * One live route the session is currently allocating: the main conversation,
 * a running delegated agent, or a live workflow-stage agent. A concrete model
 * always travels as ProviderModelRoute; provider-only is an explicit unknown-
 * model allocation and matches only provider-wide quota scopes.
 */
export type ProviderAllocation = ProviderModelRoute | { provider: ProviderId; model?: never };

/**
 * What a quota scope applies to. `global` gates the whole provider; `family`
 * and `model` gate only routing decisions for that model family / exact
 * (normalized) model id; `informational` scopes are surfaced for display
 * (e.g. an unrecognized Codex additional limit) but never gate routing.
 */
export type ScopeApplicability =
  | { type: "global" }
  | { type: "family"; id: string }
  | { type: "model"; id: string }
  | { type: "informational" };

/**
 * One provider+scope quota observation: a window (five_hour), a model family
 * (fable, spark, claude-gpt, gemini), or an informational bucket. Warning and
 * routing are stored together so a scope's display text and its routing
 * eligibility can never drift apart.
 */
export interface ScopedQuotaEntry {
  scopeKey: string;
  displayLabel: string;
  applicability: ScopeApplicability;
  warning: UsageWarning | null;
  routing: RoutingUsageState | null;
}

export interface RoutingUsageSnapshot {
  /** Legacy derived view: the worst live scope per provider. */
  byProvider: Partial<Record<ProviderId, RoutingUsageState>>;
  /** Full provider -> scope key -> scoped entry view (optional for older literals). */
  byProviderScope?: Partial<Record<ProviderId, Record<string, ScopedQuotaEntry>>>;
}

export interface UsageLimitSnapshot {
  raw: RawUtilization;
  limits: UsageLimitState;
  warning: UsageWarning | null;
  routing: RoutingUsageSnapshot;
}

export interface UsageLimitsProvider {
  getSnapshot(): UsageLimitSnapshot;
  subscribe(fn: () => void): () => void;
  warningForProvider(provider: ProviderId): UsageWarning | null;
  worstProviderWarning(): UsageWarning | null;
}

let provider: UsageLimitsProvider | null = null;

export function defaultUsageLimitSnapshot(): UsageLimitSnapshot {
  return {
    raw: {},
    limits: {
      status: "allowed",
      unifiedRateLimitFallbackAvailable: false,
      isOverageActive: false,
    },
    warning: null,
    routing: { byProvider: {}, byProviderScope: {} },
  };
}

export function registerUsageLimitsProvider(impl: UsageLimitsProvider): void {
  provider = impl;
}

function requireUsageLimitsProvider(): UsageLimitsProvider {
  if (provider === null) {
    throw new Error("Usage limit provider is not registered");
  }
  return provider;
}

export function getUsageLimitSnapshot(): UsageLimitSnapshot {
  return requireUsageLimitsProvider().getSnapshot();
}

export function subscribeUsageLimits(fn: () => void): () => void {
  return requireUsageLimitsProvider().subscribe(fn);
}

export function warningForProvider(provider: ProviderId): UsageWarning | null {
  return requireUsageLimitsProvider().warningForProvider(provider);
}

export function worstProviderWarning(): UsageWarning | null {
  return requireUsageLimitsProvider().worstProviderWarning();
}

export function _resetUsageLimitsProviderForTests(): void {
  provider = null;
}
