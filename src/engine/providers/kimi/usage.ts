import { providerEndpoint } from "@/devtools/config.ts";
import { usageFetchSignal } from "@/engine/providers/_shared/usage-fetch.ts";
import { refreshProviderQuota } from "@/engine/providers/quota-refresh.ts";
import { applyQuotaWarning, type QuotaCandidate } from "@/engine/session/usage/quota-warning.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import { currentApiKey } from "./auth.ts";

export const API_USAGE_URL = providerEndpoint(
  "kimi",
  "usage",
  "https://api.kimi.com/coding/v1/usages",
);

export interface KimiUsageRow {
  label: string;
  used: number;
  limit: number;
  resetsAt?: string | null | undefined;
  resetInSeconds?: number | undefined;
}

export interface KimiExtraUsage {
  balanceCents: number;
  totalCents: number;
  monthlyChargeLimitEnabled: boolean;
  monthlyChargeLimitCents: number;
  monthlyUsedCents: number;
  currency: string;
}

export interface KimiUsage {
  summary?: KimiUsageRow | undefined;
  limits: KimiUsageRow[];
  extraUsage?: KimiExtraUsage | null | undefined;
}

export async function fetchKimiUsage(): Promise<KimiUsage | null> {
  const apiKey = await currentApiKey();
  const resp = await fetch(API_USAGE_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: usageFetchSignal(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${truncateEllipsis(text, 240)}`);
  }
  return parseKimiUsagePayload(await resp.json());
}

export function parseKimiUsagePayload(value: unknown): KimiUsage | null {
  const root = objectValue(value);
  if (!root) return null;
  const usage = objectValue(root.usage);
  const summary = usage ? toUsageRow(usage, "Weekly limit") : undefined;
  const limits: KimiUsageRow[] = [];
  if (Array.isArray(root.limits)) {
    root.limits.forEach((item, idx) => {
      const itemObj = objectValue(item);
      if (!itemObj) return;
      const detail = objectValue(itemObj.detail) ?? itemObj;
      const window = objectValue(itemObj.window) ?? {};
      const label = limitLabel(itemObj, detail, window, idx);
      const row = toUsageRow(detail, label);
      if (row) limits.push(row);
    });
  }
  const extraUsage = parseKimiExtraUsage(root.boosterWallet);
  if (!summary && limits.length === 0 && extraUsage === null) return null;
  return { ...(summary ? { summary } : {}), limits, extraUsage };
}

const FIXED_POINT_CENTS = 1_000_000;

function parseKimiExtraUsage(value: unknown): KimiExtraUsage | null {
  const wallet = objectValue(value);
  const balance = objectValue(wallet?.balance);
  if (!wallet || !balance || balance.type !== "BOOSTER") return null;
  const totalRaw = intValue(balance.amount);
  if (totalRaw === null || totalRaw <= 0) return null;
  const monthlyLimit = moneyValue(wallet.monthlyChargeLimit);
  const monthlyUsed = moneyValue(wallet.monthlyUsed);
  return {
    balanceCents: fixedPointCents(intValue(balance.amountLeft) ?? 0),
    totalCents: fixedPointCents(totalRaw),
    monthlyChargeLimitEnabled: wallet.monthlyChargeLimitEnabled === true,
    monthlyChargeLimitCents: monthlyLimit?.cents ?? 0,
    monthlyUsedCents: monthlyUsed?.cents ?? 0,
    currency: monthlyLimit?.currency || monthlyUsed?.currency || "USD",
  };
}

function fixedPointCents(value: number): number {
  const cents = value / FIXED_POINT_CENTS;
  if (cents > 0 && cents < 1) return 1;
  return Math.round(cents);
}

function moneyValue(value: unknown): { cents: number; currency: string } | null {
  const money = objectValue(value);
  if (!money) return null;
  const cents = intValue(money.priceInCents);
  if (cents === null) return null;
  return { cents, currency: stringValue(money.currency) ?? "" };
}

function toUsageRow(data: Record<string, unknown>, defaultLabel: string): KimiUsageRow | null {
  const limit = intValue(data.limit);
  let used = intValue(data.used);
  if (used === null) {
    const remaining = intValue(data.remaining);
    if (remaining !== null && limit !== null) used = limit - remaining;
  }
  if (used === null && limit === null) return null;
  const reset = resetFields(data);
  return {
    label: stringValue(data.name) ?? stringValue(data.title) ?? defaultLabel,
    used: Math.max(0, used ?? 0),
    limit: Math.max(0, limit ?? 0),
    ...reset,
  };
}

function limitLabel(
  item: Record<string, unknown>,
  detail: Record<string, unknown>,
  window: Record<string, unknown>,
  idx: number,
): string {
  for (const key of ["name", "title", "scope"]) {
    const value = stringValue(item[key]) ?? stringValue(detail[key]);
    if (value) return value;
  }
  const duration = intValue(window.duration ?? item.duration ?? detail.duration);
  const unit = String(window.timeUnit ?? item.timeUnit ?? detail.timeUnit ?? "");
  if (duration && duration > 0) {
    if (unit.includes("MINUTE")) {
      return duration >= 60 && duration % 60 === 0
        ? `${duration / 60}h limit`
        : `${duration}m limit`;
    }
    if (unit.includes("HOUR")) return `${duration}h limit`;
    if (unit.includes("DAY")) return `${duration}d limit`;
    return `${duration}s limit`;
  }
  return `Limit #${idx + 1}`;
}

function resetFields(data: Record<string, unknown>): {
  resetsAt?: string | null | undefined;
  resetInSeconds?: number | undefined;
} {
  for (const key of ["reset_at", "resetAt", "reset_time", "resetTime"]) {
    const value = stringValue(data[key]);
    if (value) return { resetsAt: value };
  }
  for (const key of ["reset_in", "resetIn", "ttl", "window"]) {
    const value = intValue(data[key]);
    if (value !== null && value > 0) return { resetInSeconds: value };
  }
  return {};
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function intValue(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : null;
}

export async function refreshKimiQuotaWarning(): Promise<void> {
  await refreshProviderQuota("kimi");
}

export function applyKimiQuotaWarning(usage: KimiUsage | null): void {
  if (!usage) {
    applyQuotaWarning("kimi", []);
    return;
  }
  const candidates: QuotaCandidate[] = [];
  pushKimiCandidate(candidates, usage.summary, "Kimi weekly limit");
  for (const row of usage.limits) {
    pushKimiCandidate(candidates, row, kimiRowLabel(row.label));
  }
  applyQuotaWarning("kimi", candidates);
}

function pushKimiCandidate(
  out: QuotaCandidate[],
  row: KimiUsageRow | undefined,
  label: string,
): void {
  if (!row || row.limit <= 0) return;
  const utilization = (row.used / row.limit) * 100;
  out.push({
    label,
    utilization,
    resetsAt: kimiResetIso(row),
    provider: "kimi",
    trackingStatus: "tracked",
  });
}

function kimiResetIso(row: KimiUsageRow): string | null {
  if (row.resetsAt) return row.resetsAt;
  if (row.resetInSeconds && row.resetInSeconds > 0) {
    return new Date(Date.now() + row.resetInSeconds * 1000).toISOString();
  }
  return null;
}

function kimiRowLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0) return "Kimi limit";
  if (/limit$/i.test(trimmed)) return `Kimi ${trimmed}`;
  return `Kimi ${trimmed} limit`;
}
