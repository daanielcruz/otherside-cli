import { compactionSummaryRefFromUnknown } from "@/engine/session/compact/summary-spill.ts";
import { readMcpCallIdentity } from "@/kernel/mcp/protocol/tool-label.ts";
import { isMcpToolName } from "@/kernel/mcp/protocol/wire-name.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
import {
  isProviderId,
  type ProviderId,
  type ProviderModelRoute,
} from "@/kernel/std/types/provider-ids.ts";
import { recordsFromForeignLine } from "./foreign-line.ts";
import type {
  AssistantMessageRecord,
  AssistantRequestUsage,
  AttachmentRecord,
  CompactionMarkRecord,
  CompactKeepList,
  ForeignAttachment,
  GoalStatusAttachment,
  OsSidecar,
  PreservedSegment,
  QueuedCommandAttachment,
  RecordType,
  SessionMetaRecord,
  SessionRecord,
  Timestamp,
  UserMessageRecord,
} from "./schema.ts";
import { KNOWN_TYPES, normalizeRecordRoute, nowIso } from "./schema.ts";

export const SYNTHETIC_MODEL = "<synthetic>";

/** Prefer atomic agentRoute; fall back to legacy agentModel + agentProvider. */
function agentRouteFieldsFromSidecar(sidecar: OsSidecar): {
  agentRoute?: ProviderModelRoute;
  agentModel?: string;
} {
  const fromRoute = routeFromUnknown(sidecar.agentRoute);
  if (fromRoute) {
    return { agentRoute: fromRoute, agentModel: fromRoute.model };
  }
  const model = typeof sidecar.agentModel === "string" ? sidecar.agentModel : undefined;
  if (!model) return {};
  const provider =
    typeof sidecar.agentProvider === "string" && isProviderId(sidecar.agentProvider)
      ? sidecar.agentProvider
      : undefined;
  if (provider !== undefined) {
    return { agentRoute: { provider, model }, agentModel: model };
  }
  return { agentModel: model };
}

function routeFromUnknown(value: unknown): ProviderModelRoute | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as { provider?: unknown; model?: unknown };
  if (typeof rec.provider !== "string" || !isProviderId(rec.provider)) return undefined;
  if (typeof rec.model !== "string" || rec.model.length === 0) return undefined;
  return { provider: rec.provider as ProviderId, model: rec.model };
}

interface FlatLineCommon {
  isSidechain?: boolean;
  parentToolCallId?: string;
  parentAgentId?: string;
  agentDepth?: number;
  agentId?: string;
}

function healAttachmentSidecar(
  sidecar: Record<string, unknown>,
  envelope: Record<string, unknown>,
): AttachmentRecord {
  const ts =
    typeof sidecar.ts === "string"
      ? sidecar.ts
      : typeof sidecar.timestamp === "string"
        ? sidecar.timestamp
        : typeof envelope.timestamp === "string"
          ? envelope.timestamp
          : nowIso();
  const out: AttachmentRecord = {
    type: "attachment",
    ts,
    attachment: sidecar.attachment as
      | GoalStatusAttachment
      | QueuedCommandAttachment
      | ForeignAttachment,
  };
  if (sidecar.isSidechain === true) out.isSidechain = true;
  return out;
}

export function lineToRecord(line: string): SessionRecord | null {
  return lineToRecords(line)[0] ?? null;
}

export function lineToRecords(line: string): SessionRecord[] {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (typeof obj !== "object" || obj === null) return [];
    return recordsFromParsedLine(obj);
  } catch {
    return [];
  }
}

export function recordsFromParsedLine(obj: Record<string, unknown>): SessionRecord[] {
  try {
    const sidecar = obj._os;
    if (sidecar && typeof sidecar === "object") {
      const rec = sidecar as SessionRecord;
      if (rec.type === "attachment")
        return [healAttachmentSidecar(sidecar as Record<string, unknown>, obj)];
      if (typeof rec.type === "string") return [rec];
      return recordsFromFlatLine(obj, sidecar as OsSidecar);
    }
    const type = typeof obj.type === "string" ? obj.type : null;
    if (type === "attachment") return recordsFromForeignLine(obj);
    if (type && KNOWN_TYPES.has(type as RecordType)) return [obj as unknown as SessionRecord];
    return recordsFromForeignLine(obj);
  } catch {
    return [];
  }
}

function recordsFromFlatLine(env: Record<string, unknown>, sidecar: OsSidecar): SessionRecord[] {
  const ts = typeof env.timestamp === "string" ? env.timestamp : nowIso();
  const type = typeof env.type === "string" ? env.type : null;
  const common: FlatLineCommon = {
    ...(env.isSidechain === true ? { isSidechain: true } : {}),
    ...(typeof sidecar.parentToolCallId === "string"
      ? { parentToolCallId: sidecar.parentToolCallId }
      : {}),
    ...(typeof sidecar.parentAgentId === "string" ? { parentAgentId: sidecar.parentAgentId } : {}),
    ...(typeof sidecar.agentDepth === "number" ? { agentDepth: sidecar.agentDepth } : {}),
    ...(typeof env.agentId === "string" ? { agentId: env.agentId } : {}),
  };
  if (type === "user") return flatUserRecords(env, sidecar, ts, common);
  if (type === "assistant") return flatAssistantRecords(env, sidecar, ts, common);
  if (type === "attachment") {
    const attachment = env.attachment;
    if (!attachment || typeof attachment !== "object") return [];
    const rec: AttachmentRecord = {
      type: "attachment",
      ts,
      ...(typeof env.uuid === "string" ? { uuid: env.uuid } : {}),
      attachment: attachment as GoalStatusAttachment | QueuedCommandAttachment | ForeignAttachment,
    };
    if (env.isSidechain === true) rec.isSidechain = true;
    return [rec];
  }
  if (type === "system" && env.subtype === "compact_boundary") {
    return [flatCompactionRecord(env, sidecar, ts)];
  }
  if (type === "system" && env.subtype === "turn_duration") {
    return [];
  }
  if (type === "system" && env.subtype === "otherside-config") {
    return [flatConfigRecord(env, sidecar, ts)];
  }
  return [];
}

function flatConfigRecord(
  env: Record<string, unknown>,
  sidecar: OsSidecar,
  ts: Timestamp,
): SessionMetaRecord {
  const routeFields = normalizeRecordRoute(sidecar);
  return {
    type: "session_meta",
    ts,
    cwd: typeof env.cwd === "string" ? env.cwd : "",
    ...routeFields,
    ...(sidecar.effort ? { effort: sidecar.effort } : {}),
    ...(sidecar.fastMode !== undefined ? { fastMode: sidecar.fastMode } : {}),
    ...(sidecar.ultracode !== undefined ? { ultracode: sidecar.ultracode } : {}),
    ...(sidecar.remoteEnabled !== undefined ? { remoteEnabled: sidecar.remoteEnabled } : {}),
  };
}

function flatMessageBlocks(env: Record<string, unknown>): Record<string, unknown>[] {
  const message = env.message;
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
}

function flatUserRecords(
  env: Record<string, unknown>,
  sidecar: OsSidecar,
  ts: Timestamp,
  common: FlatLineCommon,
): SessionRecord[] {
  const out: SessionRecord[] = [];
  const textParts: string[] = [];
  const inlineImages: ContentBlock[] = [];
  for (const block of flatMessageBlocks(env)) {
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
      continue;
    }
    if (block.type === "image") {
      inlineImages.push(block as unknown as ContentBlock);
      continue;
    }
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      out.push({
        type: "tool_result",
        ts,
        ...(typeof env.uuid === "string" ? { uuid: env.uuid } : {}),
        call_id: block.tool_use_id,
        result: block.content ?? "",
        is_error: block.is_error === true,
        ...(sidecar.toolResultMeta ? { meta: sidecar.toolResultMeta } : {}),
        ...agentRouteFieldsFromSidecar(sidecar),
        ...common,
      });
    }
  }
  if (out.length > 0) return out;
  const routeFields = normalizeRecordRoute(sidecar);
  const rec: UserMessageRecord = {
    type: "user_message",
    ts,
    ...(typeof env.uuid === "string" ? { uuid: env.uuid } : {}),
    content: textParts.join("\n"),
    ...(typeof env.permissionMode === "string" ? { permissionMode: env.permissionMode } : {}),
    ...routeFields,
    ...(sidecar.pastedImages ? { pastedImages: sidecar.pastedImages } : {}),
    ...(sidecar.imagePasteIds ? { imagePasteIds: sidecar.imagePasteIds } : {}),
    ...(inlineImages.length > 0 ? { inlineImages } : {}),
    ...(sidecar.attachments ? { attachments: sidecar.attachments } : {}),
    ...(sidecar.queueId ? { queueId: sidecar.queueId } : {}),
    ...(sidecar.isRemote ? { isRemote: true } : {}),
    ...common,
  };
  return [rec];
}

function flatAssistantRecords(
  env: Record<string, unknown>,
  sidecar: OsSidecar,
  ts: Timestamp,
  common: FlatLineCommon,
): SessionRecord[] {
  const message =
    env.message && typeof env.message === "object"
      ? (env.message as Record<string, unknown>)
      : undefined;
  const rawModel = typeof message?.model === "string" ? message.model : undefined;
  const model = rawModel === SYNTHETIC_MODEL ? undefined : rawModel;
  const routeFields = normalizeRecordRoute({
    route: sidecar.route,
    provider: sidecar.provider,
    model: sidecar.model ?? model,
  });
  const out: SessionRecord[] = [];
  const textParts: string[] = [];
  let thinking = "";
  let thinkingSignature: string | undefined;
  for (const block of flatMessageBlocks(env)) {
    if (block.type === "thinking" && typeof block.thinking === "string") {
      thinking = thinking ? `${thinking}\n${block.thinking}` : block.thinking;
      if (typeof block.signature === "string" && block.signature.length > 0) {
        thinkingSignature = block.signature;
      }
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
      continue;
    }
    if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      // The sidecar identity belongs to the MCP call this envelope carries; a
      // block that is not an MCP call never claims it.
      const identity = isMcpToolName(block.name) ? readMcpCallIdentity(sidecar.mcpIdentity) : null;
      out.push({
        type: "tool_call",
        ts,
        ...(typeof env.uuid === "string" ? { uuid: env.uuid } : {}),
        tool_name: block.name,
        args: block.input ?? {},
        call_id: block.id,
        ...(identity ? { mcpIdentity: identity } : {}),
        ...routeFields,
        ...common,
      });
    }
  }
  const usage = assistantUsageFromLine(message?.usage, sidecar);
  const hasBody = textParts.length > 0 || thinking.length > 0 || thinkingSignature !== undefined;
  if (hasBody || out.length === 0) {
    const rec: AssistantMessageRecord = {
      type: "assistant_message",
      ts,
      ...(typeof env.uuid === "string" ? { uuid: env.uuid } : {}),
      content: textParts.join("\n"),
      ...(thinking ? { thinking } : {}),
      ...(thinkingSignature ? { thinkingSignature } : {}),
      ...(usage ? { usage } : {}),
      ...routeFields,
      ...(typeof sidecar.producedAccount === "string" && sidecar.producedAccount
        ? { producedAccount: sidecar.producedAccount }
        : {}),
      ...common,
    };
    out.unshift(rec);
  }
  return out;
}

function assistantUsageFromLine(
  usage: unknown,
  sidecar: OsSidecar,
): AssistantRequestUsage | undefined {
  const raw =
    usage && typeof usage === "object"
      ? (usage as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const stamp: AssistantRequestUsage = {
    input_tokens: nonNegativeInt(raw.input_tokens),
    output_tokens: nonNegativeInt(raw.output_tokens),
    thought_tokens: nonNegativeInt(sidecar.thoughtTokens),
    cache_creation_input_tokens: nonNegativeInt(raw.cache_creation_input_tokens),
    cache_read_input_tokens: nonNegativeInt(raw.cache_read_input_tokens),
    request_count: nonNegativeInt(sidecar.requestCount),
  };
  const hasTokens =
    stamp.input_tokens > 0 ||
    stamp.output_tokens > 0 ||
    stamp.thought_tokens > 0 ||
    stamp.cache_creation_input_tokens > 0 ||
    stamp.cache_read_input_tokens > 0;
  if (!hasTokens && sidecar.requestCount === undefined) return undefined;
  return stamp;
}

function flatCompactionRecord(
  env: Record<string, unknown>,
  sidecar: OsSidecar,
  ts: Timestamp,
): CompactionMarkRecord {
  const compaction = sidecar.compaction;
  const rec: CompactionMarkRecord = {
    type: "compaction_mark",
    ts,
    summary_ref: compactionSummaryRefFromUnknown(
      compaction?.summaryRef ?? compactionSummaryFromEnvelope(env),
    ),
  };
  if (typeof env.uuid === "string") rec.uuid = env.uuid;
  Object.assign(rec, normalizeRecordRoute(sidecar));
  if (compaction?.version !== undefined) rec.version = compaction.version;
  if (typeof env.logicalParentUuid === "string") rec.leafUuid = env.logicalParentUuid;
  const preservedSegment = preservedSegmentFromUnknown(
    compaction?.preservedSegment ?? objectRecord(env.compactMetadata)?.preservedSegment,
  );
  if (preservedSegment) rec.preservedSegment = preservedSegment;
  const preservedMessages = preservedMessagesFromUnknown(
    compaction?.preservedMessages ?? objectRecord(env.compactMetadata)?.preservedMessages,
  );
  if (preservedMessages) rec.preservedMessages = preservedMessages;
  if (compaction?.preTokens !== undefined) rec.preTokens = compaction.preTokens;
  if (compaction?.trigger !== undefined) rec.trigger = compaction.trigger;
  if (compaction?.preservedImages !== undefined) rec.preservedImages = compaction.preservedImages;
  if (compaction?.error !== undefined) rec.error = compaction.error;
  if (compaction?.rapidRefillCount !== undefined)
    rec.rapidRefillCount = compaction.rapidRefillCount;
  if (compaction?.consecutiveFailures !== undefined)
    rec.consecutiveFailures = compaction.consecutiveFailures;
  return rec;
}

export function compactionSummaryFromEnvelope(env: Record<string, unknown>): unknown {
  if ("summary_ref" in env) return env.summary_ref;
  if ("summary" in env) return env.summary;
  const content = env.content;
  return typeof content === "string" && content !== "Conversation compacted" ? content : "";
}

export function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function preservedSegmentFromUnknown(value: unknown): PreservedSegment | null {
  const raw = objectRecord(value);
  if (
    raw === null ||
    typeof raw.headUuid !== "string" ||
    typeof raw.tailUuid !== "string" ||
    typeof raw.anchorUuid !== "string"
  )
    return null;
  return { headUuid: raw.headUuid, tailUuid: raw.tailUuid, anchorUuid: raw.anchorUuid };
}

export function preservedMessagesFromUnknown(value: unknown): CompactKeepList | null {
  const raw = objectRecord(value);
  if (raw === null || typeof raw.anchorUuid !== "string" || !Array.isArray(raw.uuids)) return null;
  const uuids = raw.uuids.filter((uuid): uuid is string => typeof uuid === "string");
  if (uuids.length === 0 || uuids.length !== raw.uuids.length) return null;
  return { uuids, anchorUuid: raw.anchorUuid };
}

export function nonNegativeInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
