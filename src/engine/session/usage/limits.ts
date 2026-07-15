import { formatQuotaWarningMessage } from "@/engine/session/usage/format.ts";
import { QUOTA_BLOCK_RATIO, QUOTA_WARN_RATIO } from "@/engine/session/usage/thresholds.ts";
import {
  QUOTA_STATUSES,
  type QuotaStatus,
  type RateLimitWindow,
  type RawUtilization,
  type RawWindowUtilization,
  ROUTING_BALANCE_STATUSES,
  ROUTING_TRACKING_STATUSES,
  type RoutingBalanceStatus,
  type RoutingTrackingStatus,
  type RoutingUsageSnapshot,
  type RoutingUsageState,
  registerUsageLimitsProvider,
  type ScopeApplicability,
  type ScopedQuotaEntry,
  type UsageLimitSnapshot,
  type UsageLimitState,
  type UsageWarning,
} from "@/kernel/channels/usage-limits.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";

export { formatResetTime } from "@/engine/session/usage/format.ts";

export type {
  QuotaStatus,
  RateLimitWindow,
  RawUtilization,
  RawWindowUtilization,
  RoutingBalanceStatus,
  RoutingTrackingStatus,
  RoutingUsageSnapshot,
  RoutingUsageState,
  ScopeApplicability,
  ScopedQuotaEntry,
  UsageLimitSnapshot,
  UsageLimitState,
  UsageWarning,
};

export { QUOTA_STATUSES, ROUTING_BALANCE_STATUSES, ROUTING_TRACKING_STATUSES };

export interface RoutingUsageInput {
  trackingStatus?: RoutingTrackingStatus | undefined;
  utilizationPct?: number | undefined;
  utilization?: number | undefined;
  resetsAtEpochMs?: number | string | null | undefined;
  resetEpochMs?: number | string | null | undefined;
  observedAtEpochMs?: number | string | null | undefined;
  balanceStatus?: RoutingBalanceStatus | undefined;
}

const WARNING_THRESHOLD = QUOTA_WARN_RATIO;
const EPOCH_MS_THRESHOLD = 1_000_000_000_000;
/** Secondary expiry for routing entries whose provider never reported a reset epoch. */
export const EPOCHLESS_ROUTING_TTL_MS = 30 * 60_000;
const SWEEP_INTERVAL_MS = 30_000;

/** Scope key used by every provider-only compatibility API (setRoutingUsage, setExtraUsageWarning, ...). */
const GLOBAL_SCOPE_KEY = "global";

let raw: RawUtilization = {};
let limits: UsageLimitState = defaultLimits();
let observed = false;

type ScopeMap = Record<string, ScopedQuotaEntry>;
/**
 * Provider -> scope key -> scoped entry. This is the single SoT for both
 * quota warnings and routing eligibility: every provider-only API below
 * (setExtraUsageWarning, setRoutingUsage, setProviderQuotaObservation) is a
 * compatibility shim that reads/writes the "global" scope of this map, while
 * the plural quota-warning API (applyScopedQuotaWarnings) replaces a
 * provider's whole scope map atomically.
 */
const scopesByProvider: Partial<Record<ProviderId, ScopeMap>> = {};

const listeners = new Set<() => void>();
let sweepTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Providers the session is actually allocating right now: the main
 * conversation's active provider plus the providers of currently-running
 * delegated agents / workflow stages. Passive (auto-shown) warnings are scoped
 * to this set so quota state observed for an idle provider (e.g. by opening a
 * /usage tab or the companion's full-roster poll) never surfaces on its own.
 * Full-roster surfaces the user explicitly opens read warningForProvider
 * directly and stay unscoped. Null (no source registered) keeps the legacy
 * unscoped behavior.
 */
export type AllocatedProvidersSource = () => Iterable<ProviderId>;
let allocatedProvidersSource: AllocatedProvidersSource | null = null;

export function setAllocatedProvidersSource(source: AllocatedProvidersSource | null): void {
  allocatedProvidersSource = source;
}

function allocatedProviderSet(): ReadonlySet<ProviderId> | null {
  if (allocatedProvidersSource === null) return null;
  return new Set(allocatedProvidersSource());
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(): void {
  for (const fn of listeners) fn();
}

/** True when a routing usage entry should be treated as expired at `atEpochMs`. */
export function isRoutingUsageExpired(state: RoutingUsageState, atEpochMs = Date.now()): boolean {
  if (state.resetsAtEpochMs !== undefined && state.resetsAtEpochMs <= atEpochMs) return true;
  if (
    state.resetsAtEpochMs === undefined &&
    state.trackingStatus !== "unknown" &&
    atEpochMs - state.observedAtEpochMs >= EPOCHLESS_ROUTING_TTL_MS
  ) {
    return true;
  }
  return false;
}

/** True when a scope's routing (and therefore its warning) is still live. Scopes with no routing never expire. */
function isScopeLive(entry: ScopedQuotaEntry, atEpochMs = Date.now()): boolean {
  if (entry.routing === null) return true;
  return !isRoutingUsageExpired(entry.routing, atEpochMs);
}

/**
 * Delete expired scopes (routing + warning together) once, then emit at most once.
 * Returns true iff anything was removed.
 */
export function sweepExpiredRoutingUsage(atEpochMs = Date.now()): boolean {
  let removed = false;
  for (const provider of Object.keys(scopesByProvider) as ProviderId[]) {
    const scopes = scopesByProvider[provider];
    if (!scopes) continue;
    for (const key of Object.keys(scopes)) {
      const entry = scopes[key];
      if (entry === undefined || entry.routing === null) continue;
      if (!isRoutingUsageExpired(entry.routing, atEpochMs)) continue;
      delete scopes[key];
      removed = true;
    }
    if (Object.keys(scopes).length === 0) delete scopesByProvider[provider];
  }
  if (removed) emit();
  return removed;
}

/** Arm the process-local sweep timer (idempotent). First write starts it. */
export function ensureUsageSweepTimer(): void {
  if (sweepTimer !== undefined) return;
  sweepTimer = setInterval(() => {
    sweepExpiredRoutingUsage();
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

/** Test-only: stop the sweep timer so it does not leak across cases. */
export function stopUsageSweepTimerForTests(): void {
  if (sweepTimer === undefined) return;
  clearInterval(sweepTimer);
  sweepTimer = undefined;
}

export function getRawUtilization(): RawUtilization {
  return raw;
}

const RAW_WINDOW_BLOCK_RATIO = QUOTA_BLOCK_RATIO;

// True when a specific usage window is at/over its block threshold and has not
// yet reset. Used to gate a single scoped window without treating it as an
// account-wide limit. Retained for compatibility; providerRouteability now
// derives the same gate generically from the provider+scope SoT.
export function isRawWindowExhausted(window: RateLimitWindow, atEpochMs = Date.now()): boolean {
  const entry = raw[window];
  if (!entry) return false;
  if (entry.resetsAt * 1000 <= atEpochMs) return false;
  return entry.utilization >= RAW_WINDOW_BLOCK_RATIO;
}

export function getCurrentLimits(): UsageLimitState {
  return limits;
}

export function getUsageLimitSnapshot(): UsageLimitSnapshot {
  return {
    raw: { ...raw },
    limits: { ...limits },
    warning: getCurrentWarning(),
    routing: getRoutingUsageSnapshot(),
  };
}

/**
 * Header/legacy Anthropic usage write: preserves raw/limits (used by
 * getRawUtilization/getCurrentLimits and the /usage panel) and atomically
 * writes an Anthropic "global" compatibility scope so response-header-only
 * callers (ingestAnthropicHeaders) keep working without a full fetch. When
 * `raw.seven_day_fable` is present it also (re)writes the Fable family scope
 * generically, so a raw-only caller still gates just the Fable model. A
 * fetched Anthropic usage observation (applyAnthropicUsageLimits) replaces
 * this with the full per-window/family scope breakdown afterward.
 */
export function setUsageLimits(
  nextRaw: RawUtilization,
  nextLimits: UsageLimitState,
  options: { emit?: boolean } = {},
): void {
  ensureUsageSweepTimer();
  const observedAtEpochMs = Date.now();
  raw = nextRaw;
  limits = nextLimits;
  observed = true;

  putScope("anthropic", {
    scopeKey: GLOBAL_SCOPE_KEY,
    displayLabel: "Anthropic usage limit",
    applicability: { type: "global" },
    warning: getCurrentWarning(),
    routing: routingUsageFromUsageLimits(nextLimits, observedAtEpochMs),
  });

  const fableWindow = nextRaw.seven_day_fable;
  if (fableWindow) {
    putScope("anthropic", {
      scopeKey: "seven_day_fable",
      displayLabel: "Anthropic Fable limit",
      applicability: { type: "family", id: "fable" },
      warning: null,
      routing: routingFromRawWindow(fableWindow, observedAtEpochMs),
    });
  } else {
    removeScope("anthropic", "seven_day_fable");
  }

  if (options.emit !== false) emit();
}

export function clearUsageLimits(): void {
  raw = {};
  limits = defaultLimits();
  observed = false;
  // Drop every anthropic scope (global + fable + any fetched per-window scope
  // from applyAnthropicUsageLimits) so no residual warning-only scope survives.
  delete scopesByProvider.anthropic;
  emit();
}

export function hasObservedUsageLimits(): boolean {
  return observed;
}

/**
 * Compatibility warning setter. A non-null `next` targets the "global" scope
 * only. `next === null` means "this provider has no extra warning anymore" —
 * since a provider may now carry several scopes (created by
 * applyQuotaWarning's per-window legacy split or applyScopedQuotaWarnings),
 * clearing means wiping the warning half of EVERY scope, mirroring
 * clearRoutingUsage(provider)'s symmetric routing-half clear. This keeps the
 * common `setExtraUsageWarning(provider, null)` test/afterEach idiom a full
 * "this provider has nothing to report" reset regardless of scope count.
 */
export function setExtraUsageWarning(provider: ProviderId, next: UsageWarning | null): void {
  if (next === null) {
    if (clearProviderWarningScopes(provider)) emit();
    return;
  }
  if (
    writeScopeWarning(
      provider,
      GLOBAL_SCOPE_KEY,
      next,
      () => ({ type: "global" }),
      () => defaultGlobalDisplayLabel(provider),
    )
  ) {
    emit();
  }
}

function clearProviderWarningScopes(provider: ProviderId): boolean {
  const scopes = scopesByProvider[provider];
  if (!scopes) return false;
  let changed = false;
  for (const key of Object.keys(scopes)) {
    const entry = scopes[key];
    if (entry === undefined || entry.warning === null) continue;
    changed = true;
    if (entry.routing === null) delete scopes[key];
    else scopes[key] = { ...entry, warning: null };
  }
  if (Object.keys(scopes).length === 0) delete scopesByProvider[provider];
  return changed;
}

export interface ProviderQuotaObservation {
  warning: UsageWarning | null;
  /** Routing-state target; defaults to the warning's provider. */
  routingProvider?: ProviderId | undefined;
  /** Null clears the routing entry (nothing observed for this refresh). */
  routing: RoutingUsageInput | RoutingUsageState | null;
}

/**
 * Atomic per-provider quota observation: one fetch writes the warning and the
 * routing (eligibility) state together and emits at most once, so the /usage
 * bars, the statusline warning, and routing eligibility can never observe half
 * of a refresh. Legacy single-scope compatibility API: targets each side's
 * "global" scope.
 */
export function setProviderQuotaObservation(
  provider: ProviderId,
  observation: ProviderQuotaObservation,
): void {
  ensureUsageSweepTimer();
  const warningChanged = writeScopeWarning(
    provider,
    GLOBAL_SCOPE_KEY,
    observation.warning,
    () => ({ type: "global" }),
    () => defaultGlobalDisplayLabel(provider),
  );
  const routingProvider = observation.routingProvider ?? provider;
  const routingChanged = writeScopeRouting(
    routingProvider,
    GLOBAL_SCOPE_KEY,
    observation.routing,
    () => ({ type: "global" }),
    () => defaultGlobalDisplayLabel(routingProvider),
  );
  if (warningChanged || routingChanged) emit();
}

/**
 * Atomically replace a provider's COMPLETE scope map (every scope not
 * present in `observations` is dropped) and emit at most once. This is the
 * write path for the plural quota-warning API (applyScopedQuotaWarnings) and
 * for providers whose fetched usage carries several concurrently-live
 * windows/families (Anthropic, Codex, Antigravity).
 */
export function replaceProviderQuotaObservations(
  provider: ProviderId,
  observations: readonly ProviderScopeObservation[],
): void {
  ensureUsageSweepTimer();
  const previous = scopesByProvider[provider];
  const hadPrevious = previous !== undefined && Object.keys(previous).length > 0;
  const nextMap: ScopeMap = {};
  for (const obs of observations) {
    nextMap[obs.scopeKey] = {
      scopeKey: obs.scopeKey,
      displayLabel: obs.displayLabel,
      applicability: obs.applicability,
      warning: obs.warning,
      // A full replacement is a complete current observation. Never inherit a
      // prior reset/utilization into a newly reported scope with missing data.
      routing: normalizeRoutingUsageInput(obs.routing, null),
    };
  }
  const hasNext = Object.keys(nextMap).length > 0;
  if (hasNext) scopesByProvider[provider] = nextMap;
  else delete scopesByProvider[provider];
  if (hadPrevious || hasNext) emit();
}

export interface ProviderScopeObservation {
  scopeKey: string;
  displayLabel: string;
  applicability: ScopeApplicability;
  warning: UsageWarning | null;
  routing: RoutingUsageInput | RoutingUsageState | null;
}

/**
 * `warningForProvider` and `worstProviderWarning` derive only from live
 * scoped entries (a scope whose routing has expired contributes neither
 * warning nor routing) — Anthropic is no longer special-cased here; its
 * warning is computed once at write time (setUsageLimits / the fetched
 * replacement) and stored like any other provider's scope.
 */
export function warningForProvider(provider: ProviderId): UsageWarning | null {
  return worstLiveWarningForProvider(provider);
}

function worstLiveWarningForProvider(
  provider: ProviderId,
  atEpochMs = Date.now(),
): UsageWarning | null {
  const scopes = scopesByProvider[provider];
  if (!scopes) return null;
  const warnings: UsageWarning[] = [];
  for (const entry of Object.values(scopes)) {
    if (entry === undefined || entry.warning === null) continue;
    if (!isScopeLive(entry, atEpochMs)) continue;
    warnings.push(entry.warning);
  }
  if (warnings.length === 0) return null;
  return warnings.find((warning) => warning.severity === "error") ?? warnings[0] ?? null;
}

/**
 * The single most severe live warning across the providers the session is
 * actually allocating (error beats warning). When an allocated-providers source
 * is registered, only the main session's active provider and the providers of
 * running delegated agents/workflow stages are considered — quota observed for
 * an idle provider never surfaces passively. Without a source (headless,
 * tests), every observed provider is considered.
 */
export function worstProviderWarning(): UsageWarning | null {
  const allocated = allocatedProviderSet();
  const warnings: UsageWarning[] = [];
  for (const provider of Object.keys(scopesByProvider) as ProviderId[]) {
    if (allocated !== null && !allocated.has(provider)) continue;
    const warning = worstLiveWarningForProvider(provider);
    if (warning) warnings.push(warning);
  }
  if (warnings.length === 0) return null;
  return warnings.find((warning) => warning.severity === "error") ?? warnings[0] ?? null;
}

export function getCurrentWarning(): UsageWarning | null {
  // limits reset fields are unix seconds. Suppress stale header observations
  // until a fresh response rewrites the compatibility scope.
  const usingOverage = limits.isUsingOverage;
  const window = usingOverage ? "overage" : (limits.rateLimitType ?? "unknown");
  const resetsAt = usingOverage ? limits.overageResetsAt : limits.resetsAt;
  if (resetsAt !== undefined && resetsAt * 1000 <= Date.now()) return null;

  const rawUtilization = window === "unknown" ? undefined : raw[window]?.utilization;
  const utilizationPct =
    normalizeUtilizationPct(limits.utilization ?? rawUtilization) ??
    (limits.status === "rejected" || limits.overageStatus === "rejected"
      ? QUOTA_BLOCK_RATIO * 100
      : normalizeUtilizationPct(limits.surpassedThreshold));

  const severity =
    !usingOverage && limits.status === "rejected"
      ? "error"
      : usingOverage && limits.overageStatus === "rejected"
        ? "error"
        : (usingOverage && limits.overageStatus === "allowed_warning") ||
            (!usingOverage &&
              limits.status === "allowed_warning" &&
              (utilizationPct === undefined || utilizationPct >= WARNING_THRESHOLD * 100))
          ? "warning"
          : null;
  if (severity === null || utilizationPct === undefined) return null;
  return {
    message: formatQuotaWarningMessage("anthropic", utilizationPct, window, resetsAt ?? null),
    severity,
  };
}

/** Legacy provider-wide getter: derives the worst live scoped routing state (blocking/exhausted first, then highest utilization). */
export function getRoutingUsage(provider: ProviderId): RoutingUsageState | null {
  return worstLiveRoutingForProvider(provider);
}

function worstLiveRoutingForProvider(
  provider: ProviderId,
  atEpochMs = Date.now(),
): RoutingUsageState | null {
  const scopes = scopesByProvider[provider];
  if (!scopes) return null;
  let best: RoutingUsageState | null = null;
  for (const entry of Object.values(scopes)) {
    if (entry === undefined || entry.routing === null) continue;
    if (isRoutingUsageExpired(entry.routing, atEpochMs)) continue;
    best = best === null ? entry.routing : worseRoutingState(best, entry.routing);
  }
  return best === null ? null : { ...best };
}

/** True when a routing state is at/over the block gate: exhausted balance, or a tracked/partial window >= 100% raw. */
function isRoutingStateBlocking(state: RoutingUsageState): boolean {
  if (state.balanceStatus === "exhausted") return true;
  if (state.balanceStatus === "available") return false;
  if (state.utilizationPct === undefined) return false;
  if (state.trackingStatus !== "tracked" && state.trackingStatus !== "partial") return false;
  return state.utilizationPct >= RAW_WINDOW_BLOCK_RATIO * 100;
}

function worseRoutingState(a: RoutingUsageState, b: RoutingUsageState): RoutingUsageState {
  const aBlocking = isRoutingStateBlocking(a);
  const bBlocking = isRoutingStateBlocking(b);
  if (aBlocking !== bBlocking) return aBlocking ? a : b;
  const aUtil = a.utilizationPct ?? -1;
  const bUtil = b.utilizationPct ?? -1;
  return aUtil >= bUtil ? a : b;
}

export function getRoutingUsageSnapshot(): RoutingUsageSnapshot {
  const byProvider: Partial<Record<ProviderId, RoutingUsageState>> = {};
  const byProviderScope: Partial<Record<ProviderId, Record<string, ScopedQuotaEntry>>> = {};
  const atEpochMs = Date.now();
  for (const provider of Object.keys(scopesByProvider) as ProviderId[]) {
    const worst = worstLiveRoutingForProvider(provider, atEpochMs);
    if (worst !== null) byProvider[provider] = worst;
    const scopes = scopesByProvider[provider];
    if (!scopes) continue;
    const liveScopes: Record<string, ScopedQuotaEntry> = {};
    let any = false;
    for (const [key, entry] of Object.entries(scopes)) {
      if (entry === undefined || !isScopeLive(entry, atEpochMs)) continue;
      liveScopes[key] = deepCopyScopeEntry(entry);
      any = true;
    }
    if (any) byProviderScope[provider] = liveScopes;
  }
  return { byProvider, byProviderScope };
}

/**
 * Scoped getter suitable for routeability: every LIVE scope entry stored for
 * `provider` (global + every family/model/informational scope), deep-copied.
 * Callers (providerRouteability) filter this down to the scopes applicable to
 * a given model themselves.
 */
export function getProviderScopeEntries(provider: ProviderId): ScopedQuotaEntry[] {
  const scopes = scopesByProvider[provider];
  if (!scopes) return [];
  const atEpochMs = Date.now();
  const out: ScopedQuotaEntry[] = [];
  for (const entry of Object.values(scopes)) {
    if (entry === undefined || !isScopeLive(entry, atEpochMs)) continue;
    out.push(deepCopyScopeEntry(entry));
  }
  return out;
}

function deepCopyScopeEntry(entry: ScopedQuotaEntry): ScopedQuotaEntry {
  return {
    scopeKey: entry.scopeKey,
    displayLabel: entry.displayLabel,
    applicability: { ...entry.applicability },
    warning: entry.warning ? { ...entry.warning } : null,
    routing: entry.routing ? { ...entry.routing } : null,
  };
}

export function setRoutingUsage(
  provider: ProviderId,
  next: RoutingUsageInput | RoutingUsageState | null,
): RoutingUsageState | null {
  ensureUsageSweepTimer();
  if (
    writeScopeRouting(
      provider,
      GLOBAL_SCOPE_KEY,
      next,
      () => ({ type: "global" }),
      () => defaultGlobalDisplayLabel(provider),
    )
  ) {
    emit();
  }
  const stored = scopesByProvider[provider]?.[GLOBAL_SCOPE_KEY]?.routing ?? null;
  return stored === null ? null : { ...stored };
}

/** Clears routing state only (both the legacy global scope and every scope's routing half), preserving any warning half where practical. */
export function clearRoutingUsage(provider?: ProviderId): void {
  if (provider === undefined) {
    let changed = false;
    for (const p of Object.keys(scopesByProvider) as ProviderId[]) {
      if (clearProviderRoutingScopes(p)) changed = true;
    }
    if (changed) emit();
    return;
  }
  if (clearProviderRoutingScopes(provider)) emit();
}

function clearProviderRoutingScopes(provider: ProviderId): boolean {
  const scopes = scopesByProvider[provider];
  if (!scopes) return false;
  let changed = false;
  for (const key of Object.keys(scopes)) {
    const entry = scopes[key];
    if (entry === undefined || entry.routing === null) continue;
    changed = true;
    if (entry.warning === null) delete scopes[key];
    else scopes[key] = { ...entry, routing: null };
  }
  if (Object.keys(scopes).length === 0) delete scopesByProvider[provider];
  return changed;
}

export function normalizeRoutingUsageInput(
  input: RoutingUsageInput | RoutingUsageState | null | undefined,
  previous: RoutingUsageState | null = null,
): RoutingUsageState | null {
  if (input === null || input === undefined) return null;
  const trackingStatus = isRoutingTrackingStatus(input.trackingStatus)
    ? input.trackingStatus
    : (previous?.trackingStatus ?? "unknown");
  const balanceStatus = isRoutingBalanceStatus(input.balanceStatus)
    ? input.balanceStatus
    : (previous?.balanceStatus ?? "unknown");
  const utilizationSource =
    input.utilizationPct !== undefined
      ? input.utilizationPct
      : (input as RoutingUsageInput).utilization;
  const utilizationPct = normalizeUtilizationPct(utilizationSource) ?? previous?.utilizationPct;
  const observedAtEpochMs =
    normalizeEpochMs(input.observedAtEpochMs) ?? previous?.observedAtEpochMs ?? Date.now();
  // Only inherit a still-future reset epoch. A past previous.resetsAtEpochMs would
  // otherwise resurrect stale expiry and immediately expire (or mis-gate) the new entry.
  const inputResetsAtEpochMs = normalizeEpochMs(
    input.resetsAtEpochMs ?? (input as RoutingUsageInput).resetEpochMs,
  );
  const previousResetsAtEpochMs = previous?.resetsAtEpochMs;
  const resetsAtEpochMs =
    inputResetsAtEpochMs ??
    (previousResetsAtEpochMs !== undefined && previousResetsAtEpochMs > Date.now()
      ? previousResetsAtEpochMs
      : undefined);

  return {
    trackingStatus,
    observedAtEpochMs,
    balanceStatus,
    ...(utilizationPct !== undefined ? { utilizationPct } : {}),
    ...(resetsAtEpochMs !== undefined ? { resetsAtEpochMs } : {}),
  };
}

export function normalizeUtilizationPct(value: number | undefined | null): number | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined;
  const normalized = value >= 0 && value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, normalized));
}

export function normalizeEpochMs(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.trim().length === 0) return undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(numeric)) {
    const epochMs = Math.trunc(Math.abs(numeric) < EPOCH_MS_THRESHOLD ? numeric * 1000 : numeric);
    return epochMs;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function routingUsageFromUsageLimits(
  state: UsageLimitState,
  observedAtEpochMs = Date.now(),
): RoutingUsageState | null {
  const utilizationPct = normalizeUtilizationPct(state.utilization);
  const resetsAtEpochMs = earliestNormalizedEpochMs(state.resetsAt, state.overageResetsAt);
  const balanceStatus: RoutingBalanceStatus = state.isUsingOverage
    ? "available"
    : state.status === "rejected"
      ? "exhausted"
      : "available";
  const trackingStatus: RoutingTrackingStatus =
    utilizationPct !== undefined
      ? "tracked"
      : state.status === "allowed_warning"
        ? "partial"
        : state.status === "rejected"
          ? "unknown"
          : "unknown";

  return {
    trackingStatus,
    observedAtEpochMs: Math.trunc(observedAtEpochMs),
    balanceStatus,
    ...(utilizationPct !== undefined ? { utilizationPct } : {}),
    ...(resetsAtEpochMs !== undefined ? { resetsAtEpochMs } : {}),
  };
}

/** Routing state synthesized from a single raw RateLimitWindow entry (used for the Fable raw-window compatibility scope). */
function routingFromRawWindow(
  entry: RawWindowUtilization,
  observedAtEpochMs: number,
): RoutingUsageState {
  const utilizationPct = normalizeUtilizationPct(entry.utilization);
  const resetsAtEpochMs = normalizeEpochMs(entry.resetsAt);
  return {
    trackingStatus: "tracked",
    observedAtEpochMs,
    balanceStatus: "unknown",
    ...(utilizationPct !== undefined ? { utilizationPct } : {}),
    ...(resetsAtEpochMs !== undefined ? { resetsAtEpochMs } : {}),
  };
}

function earliestNormalizedEpochMs(...values: (number | undefined)[]): number | undefined {
  const valid = values
    .map((value) => normalizeEpochMs(value))
    .filter((value): value is number => value !== undefined);
  if (valid.length === 0) return undefined;
  return Math.min(...valid);
}

export function defaultLimits(): UsageLimitState {
  return {
    status: "allowed",
    unifiedRateLimitFallbackAvailable: false,
    isUsingOverage: false,
  };
}

function defaultGlobalDisplayLabel(provider: ProviderId): string {
  return `${provider} usage limit`;
}

function ensureProviderScopes(provider: ProviderId): ScopeMap {
  const existing = scopesByProvider[provider];
  if (existing) return existing;
  const created: ScopeMap = {};
  scopesByProvider[provider] = created;
  return created;
}

function putScope(provider: ProviderId, entry: ScopedQuotaEntry): void {
  ensureProviderScopes(provider)[entry.scopeKey] = entry;
}

function removeScope(provider: ProviderId, scopeKey: string): void {
  const scopes = scopesByProvider[provider];
  if (!scopes || !(scopeKey in scopes)) return;
  delete scopes[scopeKey];
  if (Object.keys(scopes).length === 0) delete scopesByProvider[provider];
}

function warningEqual(a: UsageWarning | null, b: UsageWarning | null): boolean {
  if (a === null || b === null) return a === b;
  return a.message === b.message && a.severity === b.severity;
}

/** Warning-only compatibility write: preserves the scope's routing half where practical. */
function writeScopeWarning(
  provider: ProviderId,
  scopeKey: string,
  next: UsageWarning | null,
  applicabilityFactory: () => ScopeApplicability,
  displayLabelFactory: () => string,
): boolean {
  const scopes = scopesByProvider[provider];
  const previous = scopes?.[scopeKey];
  const prevWarning = previous?.warning ?? null;
  if (warningEqual(prevWarning, next)) return false;
  if (next === null && (previous === undefined || previous.routing === null)) {
    if (previous !== undefined) removeScope(provider, scopeKey);
    return true;
  }
  const entry: ScopedQuotaEntry = {
    scopeKey,
    displayLabel: previous?.displayLabel ?? displayLabelFactory(),
    applicability: previous?.applicability ?? applicabilityFactory(),
    warning: next,
    routing: previous?.routing ?? null,
  };
  putScope(provider, entry);
  return true;
}

/** Routing-only compatibility write: preserves the scope's warning half where practical. Always "changes" on a non-null write (matches legacy setRoutingUsage semantics). */
function writeScopeRouting(
  provider: ProviderId,
  scopeKey: string,
  next: RoutingUsageInput | RoutingUsageState | null,
  applicabilityFactory: () => ScopeApplicability,
  displayLabelFactory: () => string,
): boolean {
  const scopes = scopesByProvider[provider];
  const previous = scopes?.[scopeKey];
  const normalized = normalizeRoutingUsageInput(next, previous?.routing ?? null);
  if (normalized === null) {
    if (previous === undefined || previous.routing === null) return false;
    if (previous.warning === null) removeScope(provider, scopeKey);
    else putScope(provider, { ...previous, routing: null });
    return true;
  }
  const entry: ScopedQuotaEntry = {
    scopeKey,
    displayLabel: previous?.displayLabel ?? displayLabelFactory(),
    applicability: previous?.applicability ?? applicabilityFactory(),
    warning: previous?.warning ?? null,
    routing: normalized,
  };
  putScope(provider, entry);
  return true;
}

const QUOTA_STATUS_SET: ReadonlySet<string> = new Set(QUOTA_STATUSES);
export function isQuotaStatus(value: unknown): value is QuotaStatus {
  return typeof value === "string" && QUOTA_STATUS_SET.has(value);
}

const ROUTING_TRACKING_STATUS_SET: ReadonlySet<string> = new Set(ROUTING_TRACKING_STATUSES);
function isRoutingTrackingStatus(value: unknown): value is RoutingTrackingStatus {
  return typeof value === "string" && ROUTING_TRACKING_STATUS_SET.has(value);
}

const ROUTING_BALANCE_STATUS_SET: ReadonlySet<string> = new Set(ROUTING_BALANCE_STATUSES);
function isRoutingBalanceStatus(value: unknown): value is RoutingBalanceStatus {
  return typeof value === "string" && ROUTING_BALANCE_STATUS_SET.has(value);
}

registerUsageLimitsProvider({
  getSnapshot: getUsageLimitSnapshot,
  subscribe,
  warningForProvider,
  worstProviderWarning,
});
