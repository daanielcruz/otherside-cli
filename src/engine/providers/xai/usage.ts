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

const BILLING_URL = `${BASE_URL}/billing?format=credits`;
const FULL_PERCENT = 100;

export async function fetchXaiUsage(): Promise<PlanQuotaData | null> {
  const tokens = await currentTokens();
  if (!tokens.accountId) throw new Error("xai billing requires an account identity");

  let resp = await fetchBilling(BILLING_URL, tokens.accessToken, tokens.accountId);
  if (resp.status === 401) {
    // Reload first — another flow may have already refreshed; only hit the
    // OAuth endpoint when the stored token is the one the server rejected.
    let newTokens = await currentTokens().catch(() => null);
    if (!newTokens || newTokens.accessToken === tokens.accessToken) {
      newTokens = await forceRefreshTokens(tokens).catch(() => null);
    }
    if (newTokens && newTokens.accessToken !== tokens.accessToken && newTokens.accountId) {
      resp = await fetchBilling(BILLING_URL, newTokens.accessToken, newTokens.accountId);
    }
  }
  return parseXaiBillingPayload(await parseXaiBillingResponse(resp));
}

function fetchBilling(url: string, accessToken: string, accountId: string): Promise<Response> {
  return fetch(url, {
    method: "GET",
    headers: {
      Authorization: authHeaderValue(accessToken),
      Accept: "application/json",
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-userid": accountId,
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
