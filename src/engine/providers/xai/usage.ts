import { usageFetchSignal } from "@/engine/providers/_shared/usage-fetch.ts";
import { currentTokens, forceRefreshTokens } from "@/engine/providers/xai/auth.ts";
import {
  authHeaderValue,
  BASE_URL,
  GROK_CLIENT_IDENTIFIER,
  GROK_CLIENT_VERSION,
  userAgent,
} from "@/engine/providers/xai/fingerprint.ts";
import {
  applyPlanQuotaWarning,
  type PlanQuotaData,
  type PlanQuotaWindow,
} from "@/engine/session/usage/plan-quota.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";

// The credits view carries the weekly period percentage. Some accounts answer
// it with period metadata only; the bare view then still reports the monthly
// included amount, which is the only usage signal such an account exposes.
const CREDITS_BILLING_URL = `${BASE_URL}/billing?format=credits`;
const MONTHLY_BILLING_URL = `${BASE_URL}/billing`;
const FULL_PERCENT = 100;

interface BillingIdentity {
  accessToken: string;
  accountId: string;
}

export async function fetchXaiUsage(): Promise<PlanQuotaData | null> {
  const tokens = await currentTokens();
  if (!tokens.accountId) throw new Error("xai billing requires an account identity");
  let identity: BillingIdentity = { accessToken: tokens.accessToken, accountId: tokens.accountId };

  let resp = await fetchBilling(CREDITS_BILLING_URL, identity);
  if (resp.status === 401) {
    // Reload first — another flow may have already refreshed; only hit the
    // OAuth endpoint when the stored token is the one the server rejected.
    let newTokens = await currentTokens().catch(() => null);
    if (!newTokens || newTokens.accessToken === tokens.accessToken) {
      newTokens = await forceRefreshTokens(tokens).catch(() => null);
    }
    if (newTokens && newTokens.accessToken !== tokens.accessToken && newTokens.accountId) {
      identity = { accessToken: newTokens.accessToken, accountId: newTokens.accountId };
      resp = await fetchBilling(CREDITS_BILLING_URL, identity);
    }
  }
  const credits = parseXaiBillingPayload(await parseXaiBillingResponse(resp));
  if (credits) return credits;

  const monthly = await fetchBilling(MONTHLY_BILLING_URL, identity);
  return parseXaiMonthlyBillingPayload(await parseXaiBillingResponse(monthly));
}

function fetchBilling(url: string, identity: BillingIdentity): Promise<Response> {
  return fetch(url, {
    method: "GET",
    headers: {
      Authorization: authHeaderValue(identity.accessToken),
      Accept: "application/json",
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-userid": identity.accountId,
      "x-grok-client-version": GROK_CLIENT_VERSION,
      "x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
      "x-grok-client-mode": "headless",
      "User-Agent": userAgent(),
    },
    signal: usageFetchSignal(),
  });
}

async function parseXaiBillingResponse(resp: Response): Promise<unknown> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${truncateEllipsis(text, 240)}`);
  }
  return resp.json();
}

export function applyXaiQuotaWarning(usage: PlanQuotaData | null): void {
  applyPlanQuotaWarning("xai", usage, "xAI");
}

export function parseXaiBillingPayload(value: unknown): PlanQuotaData | null {
  const config = objectValue(objectValue(value)?.config);
  if (!config) return null;

  const periodWindow = creditsPeriodWindow(config);
  if (!periodWindow) return null;
  return { level: null, windows: [periodWindow] };
}

/**
 * The bare billing view: an included monthly amount and what was used of it.
 * Only consulted once the credits view produced no period percentage, so a
 * weekly signal is never displaced by the coarser monthly one.
 */
export function parseXaiMonthlyBillingPayload(value: unknown): PlanQuotaData | null {
  const config = objectValue(objectValue(value)?.config);
  if (!config) return null;

  const limit = amountValue(config.monthlyLimit);
  const used = amountValue(config.used);
  if (limit === null || used === null || limit <= 0) return null;

  const percent = (used / limit) * FULL_PERCENT;
  return {
    level: null,
    windows: [
      {
        label: "Monthly limit",
        limit: { utilization: clampPercent(percent), resetsAt: isoOrNull(config.billingPeriodEnd) },
        detail: `${formatPercent(percent)}% used`,
      },
    ],
  };
}

function amountValue(value: unknown): number | null {
  return numberValue(objectValue(value)?.val);
}

function creditsPeriodWindow(config: Record<string, unknown>): PlanQuotaWindow | null {
  const percent = numberValue(config.creditUsagePercent);
  if (percent === null) return null;

  const period = objectValue(config.currentPeriod);
  const periodType = typeof period?.type === "string" ? period.type : "";
  const label = periodLabel(periodType);
  const resetsAt =
    isoOrNull(period?.end) ??
    isoOrNull(config.billingPeriodEnd) ??
    isoOrNull(config.billingPeriodStart);

  return {
    label,
    limit: {
      utilization: clampPercent(percent),
      resetsAt,
    },
    detail: `${formatPercent(percent)}% used`,
  };
}

function periodLabel(periodType: string): string {
  const normalized = periodType.toUpperCase();
  if (normalized.includes("WEEKLY")) return "Weekly limit";
  if (normalized.includes("MONTHLY")) return "Monthly limit";
  if (normalized.includes("DAILY")) return "Daily limit";
  return "Credits";
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(FULL_PERCENT, value));
}

function formatPercent(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1).replace(/\.0$/, "");
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
