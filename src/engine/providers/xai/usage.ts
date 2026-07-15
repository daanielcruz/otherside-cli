import { usageFetchSignal } from "@/engine/providers/_shared/usage-fetch.ts";
import { currentTokens } from "@/engine/providers/xai/auth.ts";
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

// Preferred source: GET /v1/billing?format=credits — live SuperGrok period
// utilization (weekly for unified billing) via creditUsagePercent. Bare
// /v1/billing is monthly included-credit accounting (used/monthlyLimit). Some
// accounts return 200 on format=credits with only period metadata and no
// utilization fields; fall back to bare billing so /usage still renders.
// Amounts may arrive as bare numbers or `{ val: number }`.
const CREDITS_BILLING_URL = `${BASE_URL}/billing?format=credits`;
const MONTHLY_BILLING_URL = `${BASE_URL}/billing`;
const FULL_PERCENT = 100;

export async function fetchXaiUsage(): Promise<PlanQuotaData | null> {
  const tokens = await currentTokens();
  const credits = await fetchBillingJson(CREDITS_BILLING_URL, tokens.accessToken);
  const fromCredits = parseXaiBillingPayload(credits);
  if (fromCredits) return fromCredits;

  const monthly = await fetchBillingJson(MONTHLY_BILLING_URL, tokens.accessToken);
  return parseXaiBillingPayload(monthly);
}

async function fetchBillingJson(url: string, accessToken: string): Promise<unknown> {
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: authHeaderValue(accessToken),
      Accept: "application/json",
      "x-grok-client-version": GROK_CLIENT_VERSION,
      "x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
      "User-Agent": userAgent(),
    },
    signal: usageFetchSignal(),
  });
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

  const windows: PlanQuotaWindow[] = [];
  const periodWindow = creditsPeriodWindow(config);
  if (periodWindow) windows.push(periodWindow);

  const onDemand = onDemandWindow(config);
  if (onDemand) windows.push(onDemand);

  // Bare / format=full shape: absolute monthly included credits.
  if (windows.length === 0) {
    const monthly = monthlyCreditsWindow(config);
    if (monthly) windows.push(monthly);
  }

  if (windows.length === 0) return null;
  return { level: null, windows };
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

function onDemandWindow(config: Record<string, unknown>): PlanQuotaWindow | null {
  const cap = valNumber(config.onDemandCap);
  const used = valNumber(config.onDemandUsed);
  if (cap === null || cap <= 0 || used === null) return null;
  return {
    label: "On-demand credits",
    limit: {
      utilization: clampPercent((used / cap) * FULL_PERCENT),
      resetsAt: isoOrNull(config.billingPeriodEnd),
    },
    detail: `${formatCount(used)} / ${formatCount(cap)} on-demand`,
  };
}

function monthlyCreditsWindow(config: Record<string, unknown>): PlanQuotaWindow | null {
  const used = valNumber(config.used);
  const limit = valNumber(config.monthlyLimit);
  if (limit === null || limit <= 0 || used === null) return null;
  return {
    label: "Monthly credits",
    limit: {
      utilization: clampPercent((used / limit) * FULL_PERCENT),
      resetsAt: isoOrNull(config.billingPeriodEnd),
    },
    detail: `${formatCount(used)} / ${formatCount(limit)} credits`,
  };
}

function periodLabel(periodType: string): string {
  const normalized = periodType.toUpperCase();
  if (normalized.includes("WEEKLY")) return "Weekly limit";
  if (normalized.includes("MONTHLY")) return "Monthly limit";
  if (normalized.includes("DAILY")) return "Daily limit";
  return "Credits";
}

// Billing amounts ride as `{ val: number }`; tolerate a bare number too.
function valNumber(value: unknown): number | null {
  const obj = objectValue(value);
  return obj ? numberValue(obj.val) : numberValue(value);
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

function formatCount(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString("en-US");
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
