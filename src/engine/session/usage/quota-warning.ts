import { formatQuotaWarningMessage } from "@/engine/session/usage/format.ts";
import {
  normalizeEpochMs,
  normalizeUtilizationPct,
  type ProviderScopeObservation,
  type RoutingBalanceStatus,
  type RoutingTrackingStatus,
  type RoutingUsageInput,
  type RoutingUsageState,
  replaceProviderQuotaObservations,
  type ScopeApplicability,
  setProviderQuotaObservation,
  type UsageWarning,
} from "@/engine/session/usage/limits.ts";
import { QUOTA_BLOCK_PCT, QUOTA_WARN_PCT } from "@/engine/session/usage/thresholds.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";

export const QUOTA_REFRESH_COOLDOWN_MS = 120_000;

export interface QuotaCandidate {
  label: string;
  utilization: number;
  resetsAt: string | number | null;
  provider?: ProviderId | undefined;
  trackingStatus?: RoutingTrackingStatus | undefined;
  balanceStatus?: RoutingBalanceStatus | undefined;
  utilizationPct?: number | undefined;
  observedAtEpochMs?: number | string | null | undefined;
  resetsAtEpochMs?: number | string | null | undefined;
  resetEpochMs?: number | string | null | undefined;
}

/**
 * Explicit wire-level exhaustion verdict from the provider's own API (e.g.
 * Codex `rate_limit_reached_type`). When present it wins over derived
 * percentages: `exhausted: true` blocks even when the rounded utilization reads
 * below 100, and `exhausted: false` keeps the provider usable even when a
 * rounded utilization reads 100. Callers refresh it on every observation so a
 * recovered provider clears atomically.
 */
export interface ExplicitQuotaSignal {
  exhausted: boolean;
  /** Display label for the spent window (used when it beats every candidate). */
  label?: string | undefined;
  /** Reset time of the spent window; drives the warning text and routing expiry. */
  resetsAt?: string | number | null | undefined;
}

interface NormalizedQuotaCandidate extends QuotaCandidate {
  normalizedUtilizationPct: number;
  normalizedObservedAtEpochMs: number;
  normalizedResetsAtEpochMs: number | undefined;
}

const LEGACY_GLOBAL_SCOPE_KEY = "global";

/**
 * Write one provider's quota observation into the usage SoT: warning text and
 * routing (eligibility) state derive from the same candidates + signal and are
 * stored atomically. Exhaustion resolution order: explicit signal when given,
 * else a candidate's own explicit `balanceStatus`, else the >= QUOTA_BLOCK_PCT
 * (100%) utilization gate on the raw percentage. Exhaustion is never inferred
 * below 100%.
 *
 * Legacy single-scope compatibility surface (kimi, glm/minimax/xai via
 * plan-quota, and any direct caller) uses the same central warning formatter as
 * first-class scoped providers. Three shapes:
 *  - an explicit `signal` collapses every candidate into ONE "global" scope
 *    (legacy combined behavior);
 *  - no signal + at least one provider-tagged candidate: every reported
 *    window becomes its own live global-applicable scope (so every window
 *    the provider reported is visible in byProviderScope), replacing the
 *    provider's whole scope map atomically;
 *  - no signal + only untagged candidates: warning-only legacy behavior — a
 *    single informational scope (never route-applicable), matching the
 *    "does not invent a provider for untagged candidates" contract.
 * Empty candidates clears the provider entirely.
 */
export function applyQuotaWarning(
  provider: ProviderId,
  candidates: QuotaCandidate[],
  signal?: ExplicitQuotaSignal,
): void {
  const normalized = normalizeCandidates(candidates);
  if (normalized === null) {
    replaceProviderQuotaObservations(provider, []);
    return;
  }

  if (signal !== undefined) {
    applyLegacyGlobalScope(provider, normalized, signal);
    return;
  }

  const tagged = normalized.filter((candidate) => candidate.provider !== undefined);
  if (tagged.length === 0) {
    applyLegacyWarningOnly(provider, normalized);
    return;
  }

  replaceProviderQuotaObservations(
    provider,
    tagged.map((candidate, index) =>
      scopeObservationFromLegacyCandidate(provider, candidate, index),
    ),
  );
}

function applyLegacyGlobalScope(
  provider: ProviderId,
  normalized: NormalizedQuotaCandidate[],
  signal: ExplicitQuotaSignal,
): void {
  const worst = worstCandidate(normalized);
  const exhausted = signal.exhausted;
  const warning = quotaWarningFor(provider, worst, exhausted, signal);
  const routingProvider = worst?.provider ?? (signal.exhausted === true ? provider : undefined);

  if (routingProvider === undefined) {
    replaceProviderQuotaObservations(provider, [legacyGlobalObservation(provider, warning, null)]);
    return;
  }
  if (routingProvider === provider) {
    replaceProviderQuotaObservations(provider, [
      legacyGlobalObservation(provider, warning, routingStateFor(worst, exhausted, signal)),
    ]);
    return;
  }
  // Rare cross-provider redirect (candidate.provider names a different
  // provider than the outer call): the atomic single-scope compat setter can
  // target warning and routing at two different providers, which a single
  // replaceProviderQuotaObservations call cannot.
  setProviderQuotaObservation(provider, {
    warning,
    routingProvider,
    routing: routingStateFor(worst, exhausted, signal),
  });
}

function applyLegacyWarningOnly(
  provider: ProviderId,
  normalized: NormalizedQuotaCandidate[],
): void {
  const worst = worstCandidate(normalized);
  const exhausted =
    worst !== null &&
    (worst.balanceStatus === "exhausted" || worst.normalizedUtilizationPct >= QUOTA_BLOCK_PCT);
  const warning = quotaWarningFor(provider, worst, exhausted, undefined);
  replaceProviderQuotaObservations(provider, [legacyGlobalObservation(provider, warning, null)]);
}

function legacyGlobalObservation(
  provider: ProviderId,
  warning: UsageWarning | null,
  routing: RoutingUsageInput | RoutingUsageState | null,
): ProviderScopeObservation {
  return {
    scopeKey: LEGACY_GLOBAL_SCOPE_KEY,
    displayLabel: `${provider} usage limit`,
    applicability: routing === null ? { type: "informational" } : { type: "global" },
    warning,
    routing,
  };
}

function legacyScopeKey(label: string, index: number): string {
  const slug = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
  return slug.length > 0 ? `${slug}#${index}` : `candidate#${index}`;
}

function scopeObservationFromLegacyCandidate(
  provider: ProviderId,
  candidate: NormalizedQuotaCandidate,
  index: number,
): ProviderScopeObservation {
  const exhausted =
    candidate.balanceStatus === "exhausted" ||
    candidate.normalizedUtilizationPct >= QUOTA_BLOCK_PCT;
  const warning = quotaWarningFor(provider, candidate, exhausted, undefined);
  const balanceStatus: RoutingBalanceStatus = exhausted
    ? "exhausted"
    : (candidate.balanceStatus ?? "unknown");
  return {
    scopeKey: legacyScopeKey(candidate.label, index),
    displayLabel: candidate.label,
    applicability: { type: "global" },
    warning,
    routing: {
      trackingStatus: candidate.trackingStatus ?? "tracked",
      observedAtEpochMs: candidate.normalizedObservedAtEpochMs,
      balanceStatus,
      utilizationPct: candidate.normalizedUtilizationPct,
      ...(candidate.normalizedResetsAtEpochMs !== undefined
        ? { resetsAtEpochMs: candidate.normalizedResetsAtEpochMs }
        : {}),
    },
  };
}

function routingStateFor(
  worst: NormalizedQuotaCandidate | null,
  exhausted: boolean,
  signal: ExplicitQuotaSignal | undefined,
): RoutingUsageInput {
  const signalResetsAtEpochMs =
    signal === undefined ? undefined : normalizeEpochMs(signal.resetsAt);
  const resetsAtEpochMs = exhausted
    ? (signalResetsAtEpochMs ?? worst?.normalizedResetsAtEpochMs)
    : worst?.normalizedResetsAtEpochMs;
  // balanceStatus is written on EVERY observation (never left to inherit the
  // previous entry) so a refresh that shows recovery clears exhaustion
  // atomically and the provider is immediately usable again.
  const balanceStatus: RoutingBalanceStatus = exhausted
    ? "exhausted"
    : signal !== undefined
      ? "available"
      : (worst?.balanceStatus ?? "unknown");
  return {
    trackingStatus: worst?.trackingStatus ?? "untracked",
    ...(worst !== null ? { utilizationPct: worst.normalizedUtilizationPct } : {}),
    ...(resetsAtEpochMs !== undefined ? { resetsAtEpochMs } : {}),
    observedAtEpochMs: worst?.normalizedObservedAtEpochMs ?? Date.now(),
    balanceStatus,
  };
}

function quotaWarningFor(
  provider: ProviderId,
  worst: NormalizedQuotaCandidate | null,
  exhausted: boolean,
  signal: ExplicitQuotaSignal | undefined,
): UsageWarning | null {
  const label = signal?.label ?? worst?.label;
  if (label === undefined) return null;
  const utilizationPct = worst?.normalizedUtilizationPct ?? (exhausted ? QUOTA_BLOCK_PCT : 0);
  const resetsAt = signal?.resetsAt !== undefined ? signal.resetsAt : (worst?.resetsAt ?? null);
  if (exhausted) {
    return {
      message: formatQuotaWarningMessage(provider, utilizationPct, label, resetsAt),
      severity: "error",
    };
  }
  if (worst !== null && utilizationPct >= QUOTA_WARN_PCT) {
    return {
      message: formatQuotaWarningMessage(provider, utilizationPct, label, resetsAt),
      severity: "warning",
    };
  }
  return null;
}

function worstCandidate(
  candidates: NormalizedQuotaCandidate[] | null,
): NormalizedQuotaCandidate | null {
  if (!candidates || candidates.length === 0) return null;
  return candidates.reduce((a, b) =>
    a.normalizedUtilizationPct >= b.normalizedUtilizationPct ? a : b,
  );
}

function normalizeCandidates(candidates: QuotaCandidate[]): NormalizedQuotaCandidate[] | null {
  const valid = candidates
    .map((candidate) => normalizeCandidate(candidate))
    .filter((candidate): candidate is NormalizedQuotaCandidate => candidate !== null);
  return valid.length > 0 ? valid : null;
}

function normalizeCandidate(candidate: QuotaCandidate): NormalizedQuotaCandidate | null {
  const normalizedUtilizationPct = normalizeUtilizationPct(
    candidate.utilizationPct ?? candidate.utilization,
  );
  if (normalizedUtilizationPct === undefined) return null;
  return {
    ...candidate,
    normalizedUtilizationPct,
    normalizedObservedAtEpochMs: normalizeEpochMs(candidate.observedAtEpochMs) ?? Date.now(),
    normalizedResetsAtEpochMs: normalizeEpochMs(
      candidate.resetsAtEpochMs ?? candidate.resetEpochMs ?? candidate.resetsAt,
    ),
  };
}

/**
 * A single provider+scope observation for the plural scoped API. `signal`,
 * when present, is an explicit per-SCOPE exhaustion verdict (e.g. Codex's
 * rate_limit_reached_type naming exactly this window) — it wins over the
 * derived utilization gate only within this same scope; it never affects any
 * other scope.
 */
export interface ScopedQuotaCandidate extends QuotaCandidate {
  scopeKey: string;
  displayLabel: string;
  applicability: ScopeApplicability;
  signal?: ExplicitQuotaSignal | undefined;
}

/**
 * Plural provider+scope quota-warning API: every entry in `scopes` becomes
 * its own live scope, and the provider's whole scope map is replaced
 * atomically (a scope omitted from `scopes` is dropped — stale windows never
 * linger). Each scope derives its warning+routing together, formatted
 * through the central formatter (format.ts#formatQuotaWarningMessage) so
 * every scoped-quota consumer renders the same
 * `[provider] pct% Window-or-family · resets ...` template. A raw 100%
 * blocks UNLESS this same scope carries an explicit `available` signal
 * (either `scope.balanceStatus === "available"` or `scope.signal = {
 * exhausted: false }`).
 */
export function applyScopedQuotaWarnings(
  provider: ProviderId,
  scopes: readonly ScopedQuotaCandidate[],
): void {
  replaceProviderQuotaObservations(
    provider,
    scopes.map((scope) => buildScopedObservation(provider, scope)),
  );
}

function warningScopeLabel(scope: ScopedQuotaCandidate): string {
  if (scope.applicability.type === "family" || scope.applicability.type === "model") {
    return scope.applicability.id;
  }
  return scope.scopeKey;
}

function buildScopedObservation(
  provider: ProviderId,
  scope: ScopedQuotaCandidate,
): ProviderScopeObservation {
  const utilizationPct = normalizeUtilizationPct(scope.utilizationPct ?? scope.utilization) ?? 0;
  const signal = scope.signal;
  const derivedExhausted =
    scope.balanceStatus === "exhausted" ||
    (scope.balanceStatus !== "available" && utilizationPct >= QUOTA_BLOCK_PCT);
  const exhausted = signal !== undefined ? signal.exhausted : derivedExhausted;
  const explicitAvailable =
    signal !== undefined ? !signal.exhausted : scope.balanceStatus === "available";
  const balanceStatus: RoutingBalanceStatus = exhausted
    ? "exhausted"
    : explicitAvailable
      ? "available"
      : (scope.balanceStatus ?? "unknown");

  const resetsAt: string | number | null =
    signal?.resetsAt !== undefined ? signal.resetsAt : (scope.resetsAt ?? null);
  const resetsAtEpochMs = normalizeEpochMs(
    scope.resetsAtEpochMs ?? scope.resetEpochMs ?? resetsAt ?? undefined,
  );
  const observedAtEpochMs = normalizeEpochMs(scope.observedAtEpochMs) ?? Date.now();
  const trackingStatus: RoutingTrackingStatus = scope.trackingStatus ?? "tracked";

  const severity: "warning" | "error" | null = exhausted
    ? "error"
    : utilizationPct >= QUOTA_WARN_PCT
      ? "warning"
      : null;
  const warning: UsageWarning | null =
    severity === null
      ? null
      : {
          message: formatQuotaWarningMessage(
            provider,
            utilizationPct,
            warningScopeLabel(scope),
            resetsAt,
          ),
          severity,
        };

  return {
    scopeKey: scope.scopeKey,
    displayLabel: scope.displayLabel,
    applicability: scope.applicability,
    warning,
    routing: {
      trackingStatus,
      observedAtEpochMs,
      balanceStatus,
      utilizationPct,
      ...(resetsAtEpochMs !== undefined ? { resetsAtEpochMs } : {}),
    },
  };
}
