import { providerEndpoint } from "@/devtools/config.ts";
import { saveProviderPlan } from "@/engine/providers/_shared/plan.ts";
import { usageFetchSignal } from "@/engine/providers/_shared/usage-fetch.ts";
import type { AnthropicRateLimitUsage } from "@/engine/providers/anthropic/usage.ts";
import { currentGlmChatCredential } from "@/engine/providers/glm/auth.ts";
import {
  applyPlanQuotaWarning,
  type PlanQuotaData,
  type PlanQuotaWindow,
} from "@/engine/session/usage/plan-quota.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";

const QUOTA_URL = providerEndpoint(
  "glm",
  "usage",
  "https://api.z.ai/api/monitor/usage/quota/limit",
);
const FULL_PERCENT = 100;

export async function fetchGlmUsage(): Promise<PlanQuotaData | null> {
  const apiKey = await currentGlmChatCredential();
  const resp = await fetch(QUOTA_URL, {
    method: "GET",
    headers: { authorization: apiKey },
    signal: usageFetchSignal(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${truncateEllipsis(text, 240)}`);
  }
  const payload = await resp.json();
  assertSuccessfulPayload(payload);
  const parsed = parseGlmUsagePayload(payload);
  if (parsed?.level) void saveProviderPlan("glm", parsed.level);
  return parsed;
}

export function applyGlmQuotaWarning(usage: PlanQuotaData | null): void {
  applyPlanQuotaWarning("glm", usage, "GLM");
}

export function parseGlmUsagePayload(value: unknown): PlanQuotaData | null {
  const root = objectValue(value);
  const data = objectValue(root?.data);
  if (!data) return null;
  const rawLimits = Array.isArray(data.limits) ? data.limits : [];
  const windows: PlanQuotaWindow[] = [];
  for (const entry of rawLimits) {
    const obj = objectValue(entry);
    if (!obj) continue;
    const window = limitToWindow(obj);
    if (window) windows.push(window);
  }
  if (windows.length === 0) return null;
  return { level: planLevel(data), windows };
}

function assertSuccessfulPayload(value: unknown): void {
  const root = objectValue(value);
  const code = numberValue(root?.code);
  const failed = root?.success === false || (code !== null && code !== 200);
  if (!failed) return;
  const msg = nullableString(root?.msg) ?? "unknown error";
  throw new Error(`glm usage ${code ?? "error"}: ${truncateEllipsis(msg, 240)}`);
}

function limitToWindow(obj: Record<string, unknown>): PlanQuotaWindow | null {
  const percentage = numberValue(obj.percentage);
  if (percentage === null) return null;
  const limit: AnthropicRateLimitUsage = {
    utilization: clampPercent(percentage),
    resetsAt: resetIso(obj.nextResetTime),
  };
  return {
    label: limitLabel(obj),
    limit,
    detail: limitDetail(obj),
  };
}

function limitLabel(obj: Record<string, unknown>): string {
  const type = nullableString(obj.type);
  const unit = numberValue(obj.unit);
  const number = numberValue(obj.number);
  if (type === "TIME_LIMIT") return "MCP quota";
  if (type === "TOKENS_LIMIT" && unit === 3 && number === 5) return "5-hour prompt pool";
  if (type === "TOKENS_LIMIT" && unit === 6) return "Weekly quota";
  if (type === "TOKENS_LIMIT") return "Token quota";
  return "Quota";
}

function limitDetail(obj: Record<string, unknown>): string | undefined {
  const used = numberValue(obj.currentValue);
  const total = numberValue(obj.usage);
  if (used === null || total === null || total <= 0) return undefined;
  return `${formatCount(used)} / ${formatCount(total)} calls`;
}

function formatCount(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString("en-US");
}

function planLevel(data: Record<string, unknown>): string | null {
  const level = nullableString(data.level);
  if (!level) return null;
  return `GLM Coding ${level.charAt(0).toUpperCase()}${level.slice(1).toLowerCase()}`;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(FULL_PERCENT, value));
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
