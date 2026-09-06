import {
  defaultEffortForModel,
  defaultModelForProvider,
  effortLevelsForModel,
  resolveModelId,
} from "@/engine/model/catalog.ts";
import type { UsageSnapshot } from "@/engine/session/compact/token-count.ts";
import { EFFORT_LEVEL_VALUES, type EffortLevel } from "@/kernel/std/types/effort.ts";
import {
  isOrchestrationMode,
  type OrchestrationMode,
} from "@/kernel/std/types/orchestration-mode.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import type { BrokerState, PermissionMode } from "@/kernel/std/types/request.ts";
import type {
  AssistantRequestUsage,
  Session,
  SessionMetaRecord,
  SessionRecord,
} from "./record/index.ts";
import { isCompactionBoundary } from "./record/index.ts";

export interface SessionBrokerState {
  provider: ProviderId;
  model: string;
  effort: EffortLevel | null;
  fastMode?: boolean | undefined;
  ultracode?: boolean | undefined;
  permissionMode?: PermissionMode | undefined;
  orchestrationMode?: OrchestrationMode | undefined;
}

import { isProviderId } from "@/kernel/std/types/provider-ids.ts";

export function shrinkToolResultRecord(
  session: Pick<Session, "records">,
  toolUseId: string,
  replacement: string,
): void {
  for (let i = session.records.length - 1; i >= 0; i -= 1) {
    const record = session.records[i];
    if (!record || record.type !== "tool_result") continue;
    if (record.call_id !== toolUseId) continue;
    record.result = replacement;
    return;
  }
}

export function resolveSessionBrokerState(
  records: readonly SessionRecord[],
  fallback: SessionBrokerState,
): SessionBrokerState {
  let provider = fallback.provider;
  let model = resolveModelId({ provider, model: fallback.model });
  let effort: EffortLevel | null = fallback.effort;
  let fastMode = fallback.fastMode;
  let ultracode: boolean | undefined;
  let orchestrationMode = fallback.orchestrationMode;
  let sawScopedRecord = false;
  let sawEffort = false;
  let sawUltracode = false;
  let sawMetaRoute = false;

  for (const record of records) {
    if (recordHasSidechainFlag(record)) continue;
    const scoped = scopedStateFromRecord(record);
    const isMeta = record.type === "session_meta";
    // A meta record snapshots the broker the user chose; other records stamp the
    // route that PRODUCED them. A route change mid-turn keeps stamping the old
    // route on the in-flight turn's records after the change, so once a meta has
    // named the route, later non-meta stamps no longer steer the restore.
    const hasProviderOrModel =
      (scoped.provider !== null || scoped.model !== null) && (isMeta || !sawMetaRoute);
    if (hasProviderOrModel) {
      if (isMeta) sawMetaRoute = true;
      const nextProvider = scoped.provider ?? provider;
      const nextModel = resolveModelId({
        provider: nextProvider,
        model:
          scoped.model ??
          (scoped.provider !== null && scoped.provider !== provider
            ? defaultModelForProvider(nextProvider)
            : model),
      });
      const changed = nextProvider !== provider || nextModel !== model;
      provider = nextProvider;
      model = nextModel;
      sawScopedRecord = true;
      if (changed && scoped.effort === null) {
        effort = null;
        sawEffort = false;
      }
    }
    if (scoped.effort !== null) {
      effort = scoped.effort;
      sawEffort = true;
    }
    if (scoped.fastMode !== null) {
      fastMode = scoped.fastMode;
    }
    if (scoped.ultracode !== null) {
      ultracode = scoped.ultracode;
      sawUltracode = true;
    }
    if (scoped.orchestrationMode !== null) {
      orchestrationMode = scoped.orchestrationMode;
    }
  }

  let permissionMode: PermissionMode | undefined = fallback.permissionMode;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const rec = records[i];
    if (!rec || recordHasSidechainFlag(rec)) continue;
    if (rec.type === "user_message" && typeof rec.permissionMode === "string") {
      const pm = rec.permissionMode;
      if (pm === "default" || pm === "accept-edits" || pm === "plan" || pm === "yolo") {
        permissionMode = pm;
        break;
      }
    }
  }

  const route = { provider, model };
  const candidateEffort =
    sawScopedRecord && !sawEffort
      ? defaultEffortForModel(route)
      : (effort ?? defaultEffortForModel(route));
  const restored: SessionBrokerState = {
    provider,
    model,
    effort:
      candidateEffort !== null && !effortLevelsForModel(route).includes(candidateEffort)
        ? defaultEffortForModel(route)
        : candidateEffort,
  };
  if (fastMode !== undefined) restored.fastMode = fastMode;
  if (sawUltracode) restored.ultracode = ultracode;
  if (permissionMode !== undefined) restored.permissionMode = permissionMode;
  if (orchestrationMode !== undefined) restored.orchestrationMode = orchestrationMode;
  return restored;
}

// Remote activation is session state owned outside the broker; the runtime
// registers a reader once at boot so every persisted meta record freezes the
// session's current activation alongside the broker fields.
let remoteEnabledReader: (() => boolean) | null = null;

export function registerSessionMetaRemoteEnabled(read: (() => boolean) | null): void {
  remoteEnabledReader = read;
}

export function sessionMetaFromBrokerState(
  session: Pick<Session, "cwd" | "storageCwd">,
  state: Pick<
    BrokerState,
    "provider" | "model" | "effort" | "fastMode" | "ultracode" | "orchestrationMode"
  >,
  ts: string,
): SessionMetaRecord {
  return {
    type: "session_meta",
    ts,
    // Persist project identity (storageCwd), never the active worktree path.
    cwd: session.storageCwd,
    provider: state.provider,
    model: state.model,
    ...(state.effort !== null ? { effort: state.effort } : {}),
    fastMode: state.fastMode,
    ...(state.ultracode !== undefined ? { ultracode: state.ultracode } : {}),
    orchestrationMode: state.orchestrationMode,
    ...(remoteEnabledReader !== null ? { remoteEnabled: remoteEnabledReader() } : {}),
  };
}

export function sessionBrokerStateKey(
  state: Pick<
    BrokerState,
    "provider" | "model" | "effort" | "fastMode" | "ultracode" | "orchestrationMode"
  >,
): string {
  return `${state.provider}\0${state.model}\0${state.effort}\0${state.fastMode}\0${state.ultracode}\0${state.orchestrationMode}`;
}

export function latestContextUsageSnapshotFromSessionRecords(
  records: readonly SessionRecord[],
  target?: Pick<SessionBrokerState, "provider" | "model">,
  usageRecords: readonly SessionRecord[] = [],
): UsageSnapshot | null {
  const targetModel = target ? resolveModelId({ ...target, model: target.model }) : null;
  let fallback: UsageSnapshot | null = null;
  for (const record of backwardByTs(records, usageRecords)) {
    if (!record) continue;
    if (recordHasSidechainFlag(record)) continue;
    if (record.type === "compaction_mark" && isCompactionBoundary(record)) break;
    if (target && scopedRecordDiverges(record, target.provider, targetModel)) break;
    const usage = requestUsageFromRecord(record);
    if (!usage) continue;
    if (target && !requestUsageMatches(usage, target.provider, targetModel)) break;

    const { snapshot } = usage;
    const contextTokens =
      snapshot.inputTokens + snapshot.cacheCreationInputTokens + snapshot.cacheReadInputTokens;
    if (contextTokens <= 0) continue;
    if (usage.requestCount >= 1) return snapshot;
    if (!fallback) fallback = snapshot;
  }
  return fallback;
}

function* backwardByTs(
  a: readonly SessionRecord[],
  b: readonly SessionRecord[],
): Generator<SessionRecord> {
  let i = a.length - 1;
  let j = b.length - 1;
  while (i >= 0 || j >= 0) {
    const left = i >= 0 ? a[i] : undefined;
    const right = j >= 0 ? b[j] : undefined;
    if (right === undefined || (left !== undefined && left.ts > right.ts)) {
      if (left !== undefined) yield left;
      i -= 1;
    } else {
      yield right;
      j -= 1;
    }
  }
}

interface RecordRequestUsage {
  snapshot: UsageSnapshot;
  requestCount: number;
  provider: string | undefined;
  model: string | undefined;
}

function requestUsageFromRecord(record: SessionRecord): RecordRequestUsage | null {
  if (record.type === "usage") {
    // Non-estimated "usage" records only exist for sidechain (fork) spend —
    // main-turn usage persists on assistant_message records. Legacy fork
    // records lack the isSidechain flag, so gate on the estimated marker too.
    if (record.estimated !== true) return null;
    return {
      snapshot: usageSnapshotFromRecord(record),
      requestCount: normalizedToken(record.request_count),
      provider: record.provider,
      model: record.model,
    };
  }
  if (record.type === "assistant_message" && record.usage) {
    return {
      snapshot: usageSnapshotFromAssistantUsage(record.usage),
      requestCount: normalizedToken(record.usage.request_count),
      provider: record.provider,
      model: record.model,
    };
  }
  return null;
}

function recordHasSidechainFlag(record: SessionRecord): boolean {
  return "isSidechain" in record && record.isSidechain === true;
}

function scopedStateFromRecord(record: SessionRecord): {
  provider: ProviderId | null;
  model: string | null;
  effort: EffortLevel | null;
  fastMode: boolean | null;
  ultracode: boolean | null;
  orchestrationMode: OrchestrationMode | null;
} {
  if (
    record.type === "tool_result" ||
    record.type === "hook_event" ||
    record.type === "injection_queued" ||
    record.type === "injection_dequeued" ||
    record.type === "attachment" ||
    record.type === "turn_completion" ||
    record.type === "content_replacement" ||
    record.type === "worktree_state"
  ) {
    return {
      provider: null,
      model: null,
      effort: null,
      fastMode: null,
      ultracode: null,
      orchestrationMode: null,
    };
  }
  return {
    provider: providerFromUnknown(record.provider),
    model: modelFromUnknown(record.model),
    effort: record.type === "session_meta" ? effortFromUnknown(record.effort) : null,
    fastMode: record.type === "session_meta" ? booleanFromUnknown(record.fastMode) : null,
    ultracode: record.type === "session_meta" ? booleanFromUnknown(record.ultracode) : null,
    orchestrationMode:
      record.type === "session_meta"
        ? orchestrationModeFromUnknown(record.orchestrationMode)
        : null,
  };
}

function stripModelDate(id: string): string {
  return id.replace(/-\d{8}$/, "");
}

function sameModelId(a: string, b: string): boolean {
  return a === b || stripModelDate(a) === stripModelDate(b);
}

function scopedRecordDiverges(
  record: SessionRecord,
  provider: ProviderId,
  model: string | null,
): boolean {
  const scoped = scopedStateFromRecord(record);
  if (scoped.provider !== null && scoped.provider !== provider) return true;
  if (model !== null && scoped.model !== null && !sameModelId(scoped.model, model)) return true;
  return false;
}

function requestUsageMatches(
  usage: RecordRequestUsage,
  provider: ProviderId,
  model: string | null,
): boolean {
  if (usage.provider !== provider) return false;
  if (model === null) return true;
  if (!usage.model) return false;
  return sameModelId(resolveModelId({ provider, model: usage.model }), model);
}

function providerFromUnknown(value: unknown): ProviderId | null {
  return isProviderId(value) ? value : null;
}

function modelFromUnknown(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function effortFromUnknown(value: unknown): EffortLevel | null {
  return typeof value === "string" && (EFFORT_LEVEL_VALUES as readonly string[]).includes(value)
    ? (value as EffortLevel)
    : null;
}

function booleanFromUnknown(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function orchestrationModeFromUnknown(value: unknown): OrchestrationMode | null {
  return isOrchestrationMode(value) ? value : null;
}

export function usageSnapshotFromAssistantUsage(usage: AssistantRequestUsage): UsageSnapshot {
  const thought = normalizedToken(usage.thought_tokens);
  const snap: UsageSnapshot = {
    inputTokens: normalizedToken(usage.input_tokens),
    outputTokens: normalizedToken(usage.output_tokens),
    cacheCreationInputTokens: normalizedToken(usage.cache_creation_input_tokens),
    cacheReadInputTokens: normalizedToken(usage.cache_read_input_tokens),
  };
  if (thought > 0) snap.thoughtTokens = thought;
  return snap;
}

function usageSnapshotFromRecord(record: Extract<SessionRecord, { type: "usage" }>): UsageSnapshot {
  const thought = normalizedToken(
    (record as unknown as Record<string, number | undefined>).thought_tokens ?? 0,
  );
  const snap: UsageSnapshot = {
    inputTokens: normalizedToken(record.input_tokens),
    outputTokens: normalizedToken(record.output_tokens),
    cacheCreationInputTokens: normalizedToken(record.cache_creation_input_tokens),
    cacheReadInputTokens: normalizedToken(record.cache_read_input_tokens),
  };
  if (thought > 0) snap.thoughtTokens = thought;
  return snap;
}

function normalizedToken(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
