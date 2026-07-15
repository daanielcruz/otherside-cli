import { providerEndpoint } from "@/devtools/config.ts";
import { usageFetchSignal } from "@/engine/providers/_shared/usage-fetch.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import { currentApiKey } from "./auth.ts";

export const API_BALANCE_URL = providerEndpoint(
  "deepseek",
  "balance",
  "https://api.deepseek.com/user/balance",
);

export interface DeepseekBalanceRow {
  currency: string;
  totalBalance: number;
  grantedBalance: number;
  toppedUpBalance: number;
}

export interface DeepseekBalance {
  isAvailable: boolean;
  rows: DeepseekBalanceRow[];
}

export async function fetchDeepseekBalance(): Promise<DeepseekBalance | null> {
  const apiKey = await currentApiKey();
  const resp = await fetch(API_BALANCE_URL, {
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
  return parseDeepseekBalancePayload(await resp.json());
}

export function parseDeepseekBalancePayload(value: unknown): DeepseekBalance | null {
  const root = objectValue(value);
  if (!root) return null;
  const isAvailable = root.is_available === true;
  const infos = Array.isArray(root.balance_infos) ? root.balance_infos : [];
  const rows: DeepseekBalanceRow[] = [];
  for (const item of infos) {
    const obj = objectValue(item);
    if (!obj) continue;
    const currency = stringValue(obj.currency) ?? "USD";
    const totalBalance = numberValue(obj.total_balance);
    const grantedBalance = numberValue(obj.granted_balance);
    const toppedUpBalance = numberValue(obj.topped_up_balance);
    rows.push({
      currency,
      totalBalance: totalBalance ?? 0,
      grantedBalance: grantedBalance ?? 0,
      toppedUpBalance: toppedUpBalance ?? 0,
    });
  }
  return { isAvailable, rows };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
