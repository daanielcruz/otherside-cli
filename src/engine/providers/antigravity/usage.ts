import { usageFetchSignal } from "@/engine/providers/_shared/usage-fetch.ts";
import { currentTokens, resolveProjectId } from "@/engine/providers/antigravity/auth.ts";
import { backendHost, userAgent } from "@/engine/providers/antigravity/fingerprint.ts";
import { refreshProviderQuota } from "@/engine/providers/quota-refresh.ts";
import {
  applyScopedQuotaWarnings,
  type ScopedQuotaCandidate,
} from "@/engine/session/usage/quota-warning.ts";
import { clamp } from "@/kernel/std/math.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";

const RETRIEVE_QUOTA_SUMMARY_PATH = "/v1internal:retrieveUserQuotaSummary";
const PERCENT = 100;

export interface AntigravityQuotaBucket {
  bucketId: string;
  displayName: string;
  remainingFraction: number | null;
  utilization: number | null;
  resetsAt: string | null;
}

export interface AntigravityQuotaGroup {
  displayName: string;
  description: string;
  buckets: AntigravityQuotaBucket[];
}

export interface AntigravityUsage {
  groups: AntigravityQuotaGroup[];
}

export async function fetchAntigravityUsage(): Promise<AntigravityUsage | null> {
  const tokens = await currentTokens();
  const project = await resolveProjectId(tokens);
  const resp = await fetch(`${backendHost()}${RETRIEVE_QUOTA_SUMMARY_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      "User-Agent": userAgent(),
      "Content-Type": "application/json",
      "Accept-Encoding": "gzip",
    },
    body: JSON.stringify({ project }),
    signal: usageFetchSignal(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${truncateEllipsis(text, 240)}`);
  }
  return parseQuotaSummary(await resp.json());
}

export function parseQuotaSummary(value: unknown): AntigravityUsage | null {
  const root = isRecord(value) ? value : null;
  if (!root || !Array.isArray(root.groups)) return null;
  const groups: AntigravityQuotaGroup[] = [];
  for (const raw of root.groups) {
    const group = groupFromEntry(raw);
    if (group && group.buckets.length > 0) groups.push(group);
  }
  return groups.length > 0 ? { groups } : null;
}

function groupFromEntry(value: unknown): AntigravityQuotaGroup | null {
  if (!isRecord(value)) return null;
  const displayName = stringValue(value.displayName);
  if (!displayName) return null;
  const rawBuckets = Array.isArray(value.buckets) ? value.buckets : [];
  const buckets: AntigravityQuotaBucket[] = [];
  for (const raw of rawBuckets) {
    const bucket = bucketFromEntry(raw);
    if (bucket) buckets.push(bucket);
  }
  return {
    displayName,
    description: stringValue(value.description) ?? "",
    buckets,
  };
}

function bucketFromEntry(value: unknown): AntigravityQuotaBucket | null {
  if (!isRecord(value)) return null;
  const displayName = stringValue(value.displayName);
  if (!displayName) return null;
  const remainingRaw = numberValue(value.remainingFraction);
  const remainingFraction = remainingRaw === null ? null : clamp(remainingRaw, 0, 1);
  return {
    bucketId: stringValue(value.bucketId) ?? displayName,
    displayName,
    remainingFraction,
    utilization: remainingFraction === null ? null : (1 - remainingFraction) * PERCENT,
    resetsAt: stringValue(value.resetTime),
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  if (!value && value !== 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

type AntigravityFamily = "claude-gpt" | "gemini";

/** Antigravity has exactly two model families, both always represented for routing purposes. */
function familyForGroup(displayName: string): AntigravityFamily {
  const name = displayName.toUpperCase();
  return name.includes("CLAUDE") || name.includes("GPT") ? "claude-gpt" : "gemini";
}

export async function refreshAntigravityQuotaWarning(modelId?: string): Promise<void> {
  // modelId is retained for call-site compatibility only: applying quota no
  // longer depends on the initiating model (both families are always fetched
  // and stored together; routeability matches the right family per-model).
  void modelId;
  await refreshProviderQuota("antigravity");
}

/**
 * One fetch groups every bucket by model family and atomically replaces
 * BOTH family scopes ("claude-gpt", "gemini") that are represented in this
 * payload — a family absent from the payload is dropped, not left stale.
 * `modelId` is accepted (and ignored) only for call-site compatibility; this
 * no longer depends on the initiating model.
 */
export function applyAntigravityQuotaWarning(
  usage: AntigravityUsage | null,
  modelId?: string,
): void {
  void modelId;
  if (!usage) {
    applyScopedQuotaWarnings("antigravity", []);
    return;
  }

  const tightestByFamily = new Map<
    AntigravityFamily,
    { group: AntigravityQuotaGroup; bucket: AntigravityQuotaBucket }
  >();
  for (const group of usage.groups) {
    const family = familyForGroup(group.displayName);
    for (const bucket of group.buckets) {
      if (bucket.utilization === null) continue;
      const current = tightestByFamily.get(family);
      if (!current || (bucket.utilization ?? 0) > (current.bucket.utilization ?? 0)) {
        tightestByFamily.set(family, { group, bucket });
      }
    }
  }

  const scopes: ScopedQuotaCandidate[] = [];
  for (const [family, { group, bucket }] of tightestByFamily) {
    const label = `Antigravity ${group.displayName} · ${bucket.displayName} limit`;
    scopes.push({
      scopeKey: family,
      displayLabel: label,
      applicability: { type: "family", id: family },
      label,
      utilization: bucket.utilization as number,
      resetsAt: bucket.resetsAt,
      trackingStatus: "tracked",
    });
  }
  applyScopedQuotaWarnings("antigravity", scopes);
}
