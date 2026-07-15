import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { listSessionFileRefs, type SessionFileRef } from "@/engine/session/paths.ts";
import type {
  AssistantMessageRecord,
  AssistantRequestUsage,
  UsageRecord,
} from "@/engine/session/record/index.ts";
import { recordsFromParsedLine } from "@/engine/session/record/index.ts";
import type {
  UsageBucket,
  UsageModelBucket,
  UsageProviderBucket,
  UsageProviderMap,
} from "@/kernel/config/config.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { withFileLock, withFileLockSync } from "@/kernel/std/fs/file-lock.ts";
import { statsCachePath } from "@/kernel/std/fs/paths.ts";
import { atomicWriteFileSync } from "@/kernel/std/fs/secure-fs.ts";
import {
  addProviderUsage,
  emptyProviderUsage,
  type ProviderUsageTotals,
  type TokenTotals,
  tokenTotalsFromUsageByProvider,
  type UsageByProvider,
} from "./provider.ts";
import { scanUsageLines } from "./scan.ts";

export type { UsageBucket, UsageModelBucket, UsageProviderBucket, UsageProviderMap };

export interface UsageStoreDelta {
  provider: ProviderId;
  model: string;
  sessionId: string;
  cwd?: string;
  usage: TokenTotals;
  requestCount?: number | undefined;
  at?: string | undefined;
}

export function addBuckets(target: UsageBucket, source: UsageBucket): void {
  target.requestCount += source.requestCount;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.thoughtTokens += source.thoughtTokens;
  target.cacheCreationInputTokens += source.cacheCreationInputTokens;
  target.cacheReadInputTokens += source.cacheReadInputTokens;
}

export function usageRecordFromDelta({
  provider,
  model,
  sessionId,
  usage,
  requestCount = 0,
  at = new Date().toISOString(),
  estimated,
  isSidechain,
}: UsageStoreDelta & {
  estimated?: boolean | undefined;
  isSidechain?: boolean | undefined;
}): UsageRecord {
  return {
    type: "usage",
    ts: at,
    provider,
    model,
    session_id: sessionId,
    request_count: requestCount,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    thought_tokens: usage.thoughtTokens,
    cache_creation_input_tokens: usage.cacheCreationInputTokens,
    cache_read_input_tokens: usage.cacheReadInputTokens,
    ...(estimated ? { estimated: true } : {}),
    ...(isSidechain ? { isSidechain: true } : {}),
  };
}

export function usageByProviderFromRecords(records: readonly unknown[]): UsageByProvider {
  const out: UsageByProvider = {};
  for (const record of records) {
    const contribution = usageContributionFromRecord(record);
    if (!contribution) continue;
    const current = out[contribution.provider] ?? emptyProviderUsage();
    out[contribution.provider] = addProviderUsage({
      current,
      model: contribution.model,
      usage: contribution.totals,
      requestCount: contribution.requestCount,
    });
  }
  return out;
}

// Main-conversation totals exclude sidechain (fork) usage: forks spend tokens
// in the ledger but never occupy the main context window. Legacy fork records
// lack the isSidechain flag, so non-estimated "usage" records are dropped too —
// main turns persist usage on assistant_message records, never bare "usage".
export function mainTokenTotalsFromRecords(records: readonly unknown[]): TokenTotals {
  const mainRecords = records.filter((record) => {
    if (!record || typeof record !== "object") return true;
    const r = record as { isSidechain?: boolean; type?: string; estimated?: boolean };
    if (r.isSidechain === true) return false;
    if (r.type === "usage" && r.estimated !== true) return false;
    return true;
  });
  return tokenTotalsFromUsageByProvider(usageByProviderFromRecords(mainRecords));
}

interface UsageContribution {
  provider: ProviderId;
  model: string;
  totals: TokenTotals;
  requestCount: number;
}

function usageContributionFromRecord(value: unknown): UsageContribution | null {
  if (isUsageRecord(value)) {
    return {
      provider: value.provider,
      model: value.model,
      totals: tokenTotalsFromRecord(value),
      requestCount: positiveInt(value.request_count),
    };
  }
  if (isAssistantUsageRecord(value)) {
    return {
      provider: value.provider,
      model: value.model,
      totals: tokenTotalsFromAssistantUsage(value.usage),
      requestCount: positiveInt(value.usage.request_count),
    };
  }
  return null;
}

interface CachedSessionUsage {
  mtime: number;
  foldedBytes: number;
  tailUuids: string[];
  usage: UsageByProvider;
}

interface UsageStatsCache {
  version: number;
  updatedAt: string;
  sessions: Record<string, CachedSessionUsage>;
}

const STATS_CACHE_VERSION = 3;
const TAIL_UUID_WINDOW = 64;

interface UsageFoldState {
  cache: UsageStatsCache;
  next: UsageStatsCache;
  dirty: boolean;
  files: SessionFileRef[];
}

function createUsageFoldState(): UsageFoldState {
  const cache = loadStatsCache();
  return {
    cache,
    next: {
      version: STATS_CACHE_VERSION,
      updatedAt: new Date().toISOString(),
      sessions: {},
    },
    dirty: false,
    files: listSessionFileRefs().sort((a, b) => a.mtime - b.mtime),
  };
}

/** Apply one session file into the fold state. Returns true on cache miss (file was folded). */
function foldSessionFileInto(state: UsageFoldState, file: SessionFileRef): boolean {
  const cached = state.cache.sessions[file.id];
  if (cached && cached.mtime === file.mtime) {
    state.next.sessions[file.id] = cached;
    return false;
  }
  state.next.sessions[file.id] = { mtime: file.mtime, ...foldSessionUsage(file, cached) };
  state.dirty = true;
  return true;
}

function shouldSaveUsageFold(state: UsageFoldState): boolean {
  return state.dirty || hasStaleSessions(state.cache, state.next);
}

/**
 * Hot paths must use {@link allTimeUsageByProviderAsync} — this sync variant blocks the
 * event loop (stats every session file, folds changed transcripts, busy-spins the cache lock).
 */
export function allTimeUsageByProvider(): UsageByProvider {
  const state = createUsageFoldState();
  for (const file of state.files) {
    foldSessionFileInto(state, file);
  }
  if (shouldSaveUsageFold(state)) saveStatsCache(state.next);
  return foldSessions(state.next.sessions);
}

export async function allTimeUsageByProviderAsync(): Promise<UsageByProvider> {
  const state = createUsageFoldState();
  for (const file of state.files) {
    const folded = foldSessionFileInto(state, file);
    if (folded) {
      // Per-file yields keep the TUI responsive; a single huge transcript still folds
      // synchronously — acceptable slice.
      await Bun.sleep(0);
    }
  }
  if (shouldSaveUsageFold(state)) await saveStatsCacheAsync(state.next);
  return foldSessions(state.next.sessions);
}

function hasStaleSessions(prev: UsageStatsCache, next: UsageStatsCache): boolean {
  return Object.keys(prev.sessions).length !== Object.keys(next.sessions).length;
}

interface SessionFold {
  foldedBytes: number;
  tailUuids: string[];
  usage: UsageByProvider;
}

function foldSessionUsage(
  file: SessionFileRef,
  cached: CachedSessionUsage | undefined,
): SessionFold {
  const base = foldBase(file, cached);
  const scan = scanUsageLines(file.path, base.foldedBytes);
  const seen = new Set(base.tailUuids);
  const records: unknown[] = [];
  const scannedUuids: string[] = [];
  for (const line of scan.lines) {
    if (line.uuid && seen.has(line.uuid)) continue;
    for (const record of recordsFromParsedLine(line.obj)) {
      if (!usageContributionFromRecord(record)) continue;
      if (line.uuid) {
        seen.add(line.uuid);
        scannedUuids.push(line.uuid);
      }
      records.push(record);
    }
  }
  return {
    foldedBytes: scan.endOffset,
    tailUuids: [...base.tailUuids, ...scannedUuids].slice(-TAIL_UUID_WINDOW),
    usage: mergedUsageByProvider(base.usage, usageByProviderFromRecords(records)),
  };
}

function foldBase(file: SessionFileRef, cached: CachedSessionUsage | undefined): SessionFold {
  const canExtend = !!cached && cached.foldedBytes > 0 && file.size >= cached.foldedBytes;
  if (!canExtend || !cached) return { foldedBytes: 0, tailUuids: [], usage: {} };
  return { foldedBytes: cached.foldedBytes, tailUuids: cached.tailUuids, usage: cached.usage };
}

function mergedUsageByProvider(base: UsageByProvider, delta: UsageByProvider): UsageByProvider {
  const out: UsageByProvider = {};
  mergeUsageByProvider(out, base);
  mergeUsageByProvider(out, delta);
  return out;
}

function foldSessions(sessions: Record<string, CachedSessionUsage>): UsageByProvider {
  const out: UsageByProvider = {};
  for (const { usage } of Object.values(sessions)) mergeUsageByProvider(out, usage);
  return out;
}

function mergeUsageByProvider(target: UsageByProvider, source: UsageByProvider): void {
  for (const [provider, usage] of Object.entries(source)) {
    if (!isProviderId(provider) || !usage) continue;
    const current = target[provider] ?? emptyProviderUsage();
    target[provider] = addProviderUsage({
      current,
      model: usage.lastModel ?? current.lastModel ?? "",
      usage: providerTokenTotals(usage),
      requestCount: usage.requestCount,
    });
  }
}

function providerTokenTotals(usage: ProviderUsageTotals): TokenTotals {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    thoughtTokens: usage.thoughtTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
  };
}

function loadStatsCache(): UsageStatsCache {
  const path = statsCachePath();
  if (!existsSync(path)) return emptyStatsCache();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<UsageStatsCache>;
    if (raw.version !== STATS_CACHE_VERSION || !raw.sessions) return emptyStatsCache();
    return {
      version: STATS_CACHE_VERSION,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
      sessions: normalizeCachedSessions(raw.sessions),
    };
  } catch {
    return emptyStatsCache();
  }
}

function normalizeCachedSessions(value: unknown): Record<string, CachedSessionUsage> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, CachedSessionUsage> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Partial<CachedSessionUsage>;
    if (typeof entry.mtime !== "number" || !entry.usage) continue;
    if (typeof entry.foldedBytes !== "number" || entry.foldedBytes < 0) continue;
    out[id] = {
      mtime: entry.mtime,
      foldedBytes: Math.floor(entry.foldedBytes),
      tailUuids: normalizeTailUuids(entry.tailUuids),
      usage: normalizeUsageByProvider(entry.usage),
    };
  }
  return out;
}

function normalizeTailUuids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").slice(-TAIL_UUID_WINDOW);
}

function normalizeUsageByProvider(value: unknown): UsageByProvider {
  if (!value || typeof value !== "object") return {};
  const out: UsageByProvider = {};
  for (const [provider, raw] of Object.entries(value)) {
    if (!isProviderId(provider) || !raw || typeof raw !== "object") continue;
    const usage = raw as Partial<ProviderUsageTotals>;
    out[provider] = {
      requestCount: positiveInt(usage.requestCount),
      inputTokens: positiveInt(usage.inputTokens),
      outputTokens: positiveInt(usage.outputTokens),
      thoughtTokens: positiveInt(usage.thoughtTokens),
      cacheCreationInputTokens: positiveInt(usage.cacheCreationInputTokens),
      cacheReadInputTokens: positiveInt(usage.cacheReadInputTokens),
      ...(typeof usage.lastModel === "string" ? { lastModel: usage.lastModel } : {}),
    };
  }
  return out;
}

function emptyStatsCache(): UsageStatsCache {
  return { version: STATS_CACHE_VERSION, updatedAt: new Date(0).toISOString(), sessions: {} };
}

function saveStatsCache(cache: UsageStatsCache): void {
  const path = statsCachePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    withFileLockSync(path, () => {
      atomicWriteFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, 0o600);
    });
  } catch {}
}

async function saveStatsCacheAsync(cache: UsageStatsCache): Promise<void> {
  const path = statsCachePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    await withFileLock(path, () => {
      atomicWriteFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, 0o600);
    });
  } catch {}
}

function tokenTotalsFromRecord(record: UsageRecord): TokenTotals {
  return {
    inputTokens: positiveInt(record.input_tokens),
    outputTokens: positiveInt(record.output_tokens),
    thoughtTokens: positiveInt(record.thought_tokens),
    cacheCreationInputTokens: positiveInt(record.cache_creation_input_tokens),
    cacheReadInputTokens: positiveInt(record.cache_read_input_tokens),
  };
}

// Sidechain "usage" records stay in: the main-session record is the only
// ledger source for fork spend (fork sidecar transcripts are never folded).
function isUsageRecord(value: unknown): value is UsageRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<UsageRecord>;
  return (
    record.type === "usage" &&
    isProviderId(record.provider) &&
    typeof record.model === "string" &&
    typeof record.session_id === "string"
  );
}

type AssistantUsageRecord = AssistantMessageRecord & {
  provider: ProviderId;
  model: string;
  usage: AssistantRequestUsage;
};

function isAssistantUsageRecord(value: unknown): value is AssistantUsageRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AssistantMessageRecord>;
  return (
    record.type === "assistant_message" &&
    record.isSidechain !== true &&
    isProviderId(record.provider) &&
    typeof record.model === "string" &&
    !!record.usage &&
    typeof record.usage === "object"
  );
}

function tokenTotalsFromAssistantUsage(usage: AssistantRequestUsage): TokenTotals {
  return {
    inputTokens: positiveInt(usage.input_tokens),
    outputTokens: positiveInt(usage.output_tokens),
    thoughtTokens: positiveInt(usage.thought_tokens),
    cacheCreationInputTokens: positiveInt(usage.cache_creation_input_tokens),
    cacheReadInputTokens: positiveInt(usage.cache_read_input_tokens),
  };
}

import { isProviderId } from "@/kernel/config/provider-ids.ts";

function positiveInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
