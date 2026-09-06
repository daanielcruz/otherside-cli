import {
  getProviderScopeEntries,
  type RoutingUsageState,
  type ScopedQuotaEntry,
} from "@/engine/session/usage/limits.ts";
import {
  getProviderCooldown,
  type ProviderCooldownRecord,
} from "@/engine/session/usage/provider-health.ts";
import { scopeAppliesToRoute } from "@/engine/session/usage/scope-applicability.ts";
import { QUOTA_BLOCK_PCT } from "@/engine/session/usage/thresholds.ts";
import type { ProviderAllocation } from "@/kernel/channels/usage-limits.ts";
import { formatResetTime } from "@/kernel/std/intl.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";

export type ProviderRoutingUsageSource = "explicit" | "unobserved";

export interface ProviderRoutingUsage {
  state: RoutingUsageState;
  source: ProviderRoutingUsageSource;
}

export interface ProviderRouteability {
  routing: ProviderRoutingUsage;
  cooldown: ProviderCooldownRecord | null;
  usable: boolean;
  notes: string[];
  blockedReasons: string[];
  // True when the block came from quota observations (exhausted balance or the
  // 100% utilization gate) rather than cooldowns/credentials. Structured so the
  // quota-fallback gate never has to parse reason strings.
  quotaBlocked: boolean;
}

/**
 * Live routing eligibility for one provider, derived from the provider+scope
 * quota SoT. Every LIVE scope applicable to (provider, model) is checked:
 * the "global" scope always applies, a "family" scope applies when `model`
 * normalizes into that family (see familyForModel below), a "model" scope
 * applies on an exact normalized-id match, and "informational" scopes never
 * apply (visible in the /usage panel, never route-applicable). Exhaustion is
 * live state: the block holds exactly while an applicable scope's balance is
 * exhausted (or a tracked/partial window sits at 100% without an explicit
 * available balance observation in THAT SAME scope), and a refresh that shows
 * recovery — or the window's reset epoch passing — makes the provider usable
 * again immediately. An `available` scope never suppresses a DIFFERENT
 * scope's block (e.g. Antigravity's Gemini family being available never
 * un-blocks an exhausted Claude/GPT family). There is no active-provider
 * exemption: the main session's own provider is blocked for delegated work
 * too when it is exhausted (`activeProvider` is retained for call
 * compatibility only).
 */
export function providerRouteability(
  provider: ProviderId,
  activeProvider?: ProviderId,
  model?: string | null,
): ProviderRouteability {
  void activeProvider;
  const allocation: ProviderAllocation =
    model === undefined || model === null ? { provider } : { provider, model };
  const applicableScopes = applicableScopeEntries(allocation);
  const routing = effectiveRoutingUsage(applicableScopes);
  const cooldown = getProviderCooldown(provider, model);
  const notes = routingUsageNotes(routing);
  const blockedReasons: string[] = [];
  if (cooldown !== null)
    blockedReasons.push(cooldownUntilText(cooldown.untilEpochMs, cooldown.reason, cooldown.model));

  let quotaBlocked = false;
  for (const scope of applicableScopes) {
    if (scope.routing === null) continue;
    if (!isScopeQuotaBlocking(scope.routing)) continue;
    blockedReasons.push(quotaBlockReason(scope));
    quotaBlocked = true;
  }

  return {
    routing,
    cooldown,
    usable: blockedReasons.length === 0,
    notes,
    blockedReasons,
    quotaBlocked,
  };
}

export function providerRoutingUsage(provider: ProviderId): ProviderRoutingUsage {
  return effectiveRoutingUsage(applicableScopeEntries({ provider }));
}

/** Every live scope applicable to one route: provider-wide + matching family/model scopes. */
function applicableScopeEntries(allocation: ProviderAllocation): ScopedQuotaEntry[] {
  const entries = getProviderScopeEntries(allocation.provider);
  if (allocation.model === undefined) {
    return entries.filter((entry) => entry.applicability.type === "global");
  }
  return entries.filter((entry) => scopeAppliesToRoute(entry.applicability, allocation));
}

/** The worst applicable routing state across the given scopes (blocking/exhausted first, then highest utilization). */
function effectiveRoutingUsage(scopes: readonly ScopedQuotaEntry[]): ProviderRoutingUsage {
  let best: RoutingUsageState | null = null;
  for (const scope of scopes) {
    if (scope.routing === null) continue;
    best = best === null ? scope.routing : worseRoutingState(best, scope.routing);
  }
  if (best === null) return { state: unknownRoutingUsage(), source: "unobserved" };
  return { state: best, source: "explicit" };
}

function worseRoutingState(a: RoutingUsageState, b: RoutingUsageState): RoutingUsageState {
  const aBlocking = isScopeQuotaBlocking(a);
  const bBlocking = isScopeQuotaBlocking(b);
  if (aBlocking !== bBlocking) return aBlocking ? a : b;
  const aUtil = a.utilizationPct ?? -1;
  const bUtil = b.utilizationPct ?? -1;
  return aUtil >= bUtil ? a : b;
}

/** True when a scope's routing exhausts the quota gate: an exhausted balance, or a raw tracked/partial window >= 100% whose balance isn't explicitly available. */
function isScopeQuotaBlocking(state: RoutingUsageState): boolean {
  if (state.balanceStatus === "exhausted") return true;
  if (state.balanceStatus === "available") return false;
  if (state.utilizationPct === undefined) return false;
  if (state.trackingStatus !== "tracked" && state.trackingStatus !== "partial") return false;
  // Raw (untruncated) percentage: 99.9 stays usable, only real 100% blocks.
  return state.utilizationPct >= QUOTA_BLOCK_PCT;
}

function unknownRoutingUsage(): RoutingUsageState {
  return {
    trackingStatus: "unknown",
    observedAtEpochMs: Date.now(),
    balanceStatus: "unknown",
  };
}

function routingUsageNotes(routing: ProviderRoutingUsage): string[] {
  const notes: string[] = [];
  const state = routing.state;
  if (state.trackingStatus === "unknown") {
    notes.push("tracking unknown; user responsibility");
  } else if (state.trackingStatus === "untracked") {
    notes.push("tracking untracked; user responsibility");
  } else if (state.trackingStatus === "partial") {
    if (state.utilizationPct !== undefined) {
      notes.push(`partial tracking; utilization ${formatPct(state.utilizationPct)}%`);
    } else {
      notes.push("partial tracking; usage unknown");
    }
  } else if (state.utilizationPct !== undefined) {
    notes.push(`tracked utilization ${formatPct(state.utilizationPct)}%`);
  } else {
    notes.push("tracked usage unavailable; user responsibility");
  }

  if (state.balanceStatus === "unknown") {
    notes.push("balance unknown; user responsibility");
  } else if (state.balanceStatus === "available") {
    notes.push("balance available");
  }

  if (routing.source === "explicit" && state.resetsAtEpochMs !== undefined) {
    notes.push(`resets at ${state.resetsAtEpochMs}`);
  }
  return notes;
}

/** Human-readable reset suffix for quota block reasons (empty when unknown/past). */
function resetSuffix(resetsAtEpochMs: number | undefined): string {
  if (resetsAtEpochMs === undefined) return "";
  const text = formatResetTime(Math.floor(resetsAtEpochMs / 1000));
  return text === null ? "" : ` (resets ${text})`;
}

function formatPct(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function cooldownUntilText(untilEpochMs: number, reason: string, model: string | null): string {
  const scope = model === null ? "provider" : `model ${model}`;
  return `${scope} cooldown until ${untilEpochMs} (${reason})`;
}

/** Blocked-reason text for one applicable scope, including its display label so multi-scope providers name the exact window. */
function quotaBlockReason(scope: ScopedQuotaEntry): string {
  const state = scope.routing;
  if (state === null) return scope.displayLabel;
  if (state.balanceStatus === "exhausted") {
    return `${scope.displayLabel}: balance exhausted${resetSuffix(state.resetsAtEpochMs)}`;
  }
  return `${scope.displayLabel}: ${state.trackingStatus} utilization ${formatPct(state.utilizationPct ?? 0)}% >= ${QUOTA_BLOCK_PCT}% threshold${resetSuffix(state.resetsAtEpochMs)}`;
}
