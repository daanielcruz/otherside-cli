import {
  QUOTA_STATUSES,
  type QuotaStatus,
  ROUTING_BALANCE_STATUSES,
  ROUTING_TRACKING_STATUSES,
  type RoutingBalanceStatus,
  type RoutingTrackingStatus,
  type RoutingUsageState,
  type UsageLimitState,
} from "@/kernel/channels/usage-limits.ts";

/**
 * Pure quota-state arithmetic: input normalization, expiry, epoch parsing, and
 * routing-state synthesis. Stateless — the scoped SoT lives in limits.ts.
 */

export interface RoutingUsageInput {
  trackingStatus?: RoutingTrackingStatus | undefined;
  utilizationPct?: number | undefined;
  utilization?: number | undefined;
  resetsAtEpochMs?: number | string | null | undefined;
  resetEpochMs?: number | string | null | undefined;
  observedAtEpochMs?: number | string | null | undefined;
  balanceStatus?: RoutingBalanceStatus | undefined;
}

const EPOCH_MS_THRESHOLD = 1_000_000_000_000;
/** Secondary expiry for routing entries whose provider never reported a reset epoch. */
export const EPOCHLESS_ROUTING_TTL_MS = 30 * 60_000;

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
  const utilizationPct =
    (input.utilizationPct !== undefined
      ? normalizeReportedPercentage(input.utilizationPct)
      : normalizeUtilizationPct((input as RoutingUsageInput).utilization)) ??
    previous?.utilizationPct;
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

function normalizeReportedPercentage(value: number | undefined | null): number | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value));
}

export function normalizeUtilizationPct(value: number | undefined | null): number | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined;
  return normalizeReportedPercentage(value <= 1 ? value * 100 : value);
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
  const balanceStatus: RoutingBalanceStatus = state.isOverageActive
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

function earliestNormalizedEpochMs(...values: (number | undefined)[]): number | undefined {
  const valid = values
    .map((value) => normalizeEpochMs(value))
    .filter((value): value is number => value !== undefined);
  if (valid.length === 0) return undefined;
  return Math.min(...valid);
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
