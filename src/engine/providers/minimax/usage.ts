import { providerEndpoint } from "@/devtools/config.ts";
import { saveProviderPlan } from "@/engine/providers/_shared/plan.ts";
import { usageFetchSignal } from "@/engine/providers/_shared/usage-fetch.ts";
import { currentApiKey } from "@/engine/providers/minimax/auth.ts";
import {
  applyPlanQuotaWarning,
  type PlanQuotaData,
  type PlanQuotaWindow,
} from "@/engine/session/usage/plan-quota.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";

const QUOTA_URL = providerEndpoint(
  "minimax",
  "usage",
  "https://www.minimax.io/v1/token_plan/remains",
);
const UNLIMITED_WEEKLY_STATUS = 3;
const FULL_PERCENT = 100;

export async function fetchMinimaxUsage(): Promise<PlanQuotaData | null> {
  const apiKey = await currentApiKey();
  const resp = await fetch(QUOTA_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal: usageFetchSignal(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${truncateEllipsis(text, 240)}`);
  }
  const parsed = parseMinimaxUsagePayload(await resp.json());
  if (parsed?.level) void saveProviderPlan("minimax", parsed.level);
  return parsed;
}

export function applyMinimaxQuotaWarning(usage: PlanQuotaData | null): void {
  applyPlanQuotaWarning("minimax", usage, "MiniMax");
}

export function parseMinimaxUsagePayload(value: unknown): PlanQuotaData | null {
  const root = objectValue(value);
  const models = root && Array.isArray(root.model_remains) ? root.model_remains : [];
  const windows: PlanQuotaWindow[] = [];
  for (const entry of models) {
    const model = objectValue(entry);
    if (!model) continue;
    const name = nullableString(model.model_name) ?? "general";
    const intervalUsed = usedFromRemaining(model.current_interval_remaining_percent);
    if (intervalUsed !== null) {
      windows.push({
        label: `${name} · 5-hour`,
        limit: { utilization: intervalUsed, resetsAt: resetIso(model.end_time) },
      });
    }
    if (numberValue(model.current_weekly_status) === UNLIMITED_WEEKLY_STATUS) {
      windows.push({
        label: `${name} · weekly`,
        limit: { utilization: 0, resetsAt: resetIso(model.weekly_end_time) },
        detail: "unlimited",
      });
      continue;
    }
    const weeklyUsed = usedFromRemaining(model.current_weekly_remaining_percent);
    if (weeklyUsed !== null) {
      windows.push({
        label: `${name} · weekly`,
        limit: { utilization: weeklyUsed, resetsAt: resetIso(model.weekly_end_time) },
      });
    }
  }
  if (windows.length === 0) return null;
  return { level: nullableString(root?.plan_level) ?? nullableString(root?.tier), windows };
}

function usedFromRemaining(value: unknown): number | null {
  const remaining = numberValue(value);
  if (remaining === null) return null;
  return Math.max(0, Math.min(FULL_PERCENT, FULL_PERCENT - remaining));
}

function resetIso(value: unknown): string | null {
  const ms = numberValue(value);
  if (ms === null || ms <= 0) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
