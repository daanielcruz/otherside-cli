import { readCompactionSummaryText } from "@/engine/session/compact/summary-spill.ts";
import { getRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
import { toolResultIsErrorField } from "@/kernel/std/types/message.ts";
import type {
  AssistantMessageRecord,
  AssistantRequestUsage,
  CompactionMarkRecord,
  OsCompactionSidecar,
  OsSidecar,
  SessionMetaRecord,
  SessionRecord,
  SessionStamp,
  UserMessageRecord,
} from "./schema.ts";
import { isChainParticipant } from "./schema.ts";
import { OTHERSIDE_VERSION, type SessionChain } from "./state.ts";

interface SerializedLine {
  type: string;
  uuid: string;
  parentUuid?: string | null;
  timestamp?: string;
  isSidechain?: boolean;
  agentId?: string;
  entrypoint?: string;
  requestId?: string;
  isMeta?: boolean;
  message?: Record<string, unknown>;
  _os: OsSidecar | SessionRecord;
  [key: string]: unknown;
}

const SYNTHETIC_MODEL = "<synthetic>";

function newUuid(): string {
  return crypto.randomUUID();
}

export function recordToLine(r: SessionRecord): string {
  return JSON.stringify(r);
}

export function serializeRecord(
  r: SessionRecord,
  chain: SessionChain,
  stamp: SessionStamp,
): string {
  const line = upstreamLineFor(r, chain, stamp);
  return JSON.stringify(line);
}

function upstreamLineFor(
  r: SessionRecord,
  chain: SessionChain,
  stamp: SessionStamp,
): SerializedLine {
  const sidechain = "isSidechain" in r && r.isSidechain === true;
  const agentId = "agentId" in r ? (r as { agentId?: string }).agentId : undefined;
  const presetUuid =
    "uuid" in r && typeof (r as { uuid?: unknown }).uuid === "string"
      ? (r as { uuid: string }).uuid
      : null;
  const base = (os: OsSidecar | SessionRecord): SerializedLine => {
    const uuid = presetUuid ?? newUuid();
    // Sidechain records are serialized only via the dedicated per-fork chain
    // (appendAgentRecordRaw → rawChainFor(`${sessionId}/${agentId}`)), never the
    // main session chain — so threading them through `chain` here cannot
    // contaminate main-session parentUuid linkage, and the per-fork transcript
    // gets a real parentUuid chain (first line null, rest threaded) instead of an
    // all-null collapse.
    const parentUuid = chain.headUuid;
    if (isChainParticipant(r.type)) chain.headUuid = uuid;
    const out: SerializedLine = {
      type: "system",
      uuid,
      parentUuid,
      userType: "external",
      timestamp: r.ts,
      sessionId: stamp.sessionId,
      cwd: stamp.cwd,
      version: stamp.version ?? OTHERSIDE_VERSION,
      _os: os,
    };
    if (stamp.gitBranch) out.gitBranch = stamp.gitBranch;
    if (sidechain) out.isSidechain = true;
    if (agentId) out.agentId = agentId;
    return out;
  };

  const applyMessageExtras = (
    out: SerializedLine,
    record: { entrypoint?: string; requestId?: string; isMeta?: boolean },
  ): void => {
    const entrypoint = record.entrypoint ?? getRuntimeKind() ?? undefined;
    if (entrypoint) out.entrypoint = entrypoint;
    if (record.requestId) out.requestId = record.requestId;
    if (record.isMeta === true) out.isMeta = true;
  };

  if (r.type === "user_message") {
    const out = base(userSidecar(r));
    out.type = "user";
    out.message = { role: "user", content: userContentBlocks(r) };
    if (r.permissionMode) out.permissionMode = r.permissionMode;
    applyMessageExtras(out, r);
    return out;
  }
  if (r.type === "assistant_message") {
    const out = base(assistantSidecar(r));
    out.type = "assistant";
    out.message = assistantMessageShape(r, out.uuid, assistantContentBlocks(r));
    applyMessageExtras(out, r);
    return out;
  }
  if (r.type === "tool_call") {
    const out = base(chainSidecar(r));
    out.type = "assistant";
    out.message = assistantMessageShape(r, out.uuid, [
      { type: "tool_use", id: r.call_id, name: r.tool_name, input: r.args ?? {} },
    ]);
    return out;
  }
  if (r.type === "tool_result") {
    const sidecar = chainSidecar(r);
    if (r.meta) sidecar.toolResultMeta = r.meta;
    if (r.agentModel) sidecar.agentModel = r.agentModel;
    const out = base(sidecar);
    out.type = "user";
    out.toolUseResult = r.toolUseResult ?? r.result;
    out.message = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: r.call_id,
          content: r.result ?? "",
          ...toolResultIsErrorField(r.is_error, r.meta),
        },
      ],
    };
    return out;
  }
  if (r.type === "compaction_mark") {
    const out = base(compactionSidecar(r));
    out.type = "system";
    out.subtype = "compact_boundary";
    out.content = "Conversation compacted";
    out.isMeta = false;
    out.level = "info";
    out.compactMetadata = {
      trigger: r.trigger === "manual" ? "manual" : "auto",
      preTokens: r.preTokens ?? 0,
      ...(r.preservedSegment ? { preservedSegment: r.preservedSegment } : {}),
      ...(r.preservedMessages ? { preservedMessages: r.preservedMessages } : {}),
    };
    const priorHead = typeof out.parentUuid === "string" ? out.parentUuid : undefined;
    const logicalParent = priorHead ?? r.leafUuid;
    if (logicalParent) out.logicalParentUuid = logicalParent;
    out.parentUuid = null;
    return out;
  }
  if (r.type === "attachment") {
    const out = base({});
    out.type = "attachment";
    out.attachment = r.attachment;
    return out;
  }
  if (r.type === "turn_completion") {
    const out = base({});
    out.type = "system";
    out.subtype = "turn_duration";
    out.durationMs = r.durationMs;
    return out;
  }
  if (r.type === "session_meta") {
    const out = base(configSidecar(r));
    out.type = "system";
    out.subtype = "otherside-config";
    return out;
  }
  const out = base(r);
  out.subtype = `otherside-${r.type.replace(/_/g, "-")}`;
  return out;
}

function configSidecar(r: SessionMetaRecord): OsSidecar {
  const out: OsSidecar = {};
  if (r.provider) out.provider = r.provider;
  if (r.model) out.model = r.model;
  if (r.effort) out.effort = r.effort;
  if (r.fastMode !== undefined) out.fastMode = r.fastMode;
  if (r.ultracode !== undefined) out.ultracode = r.ultracode;
  return out;
}

function userSidecar(r: UserMessageRecord): OsSidecar {
  const out: OsSidecar = {};
  if (r.provider) out.provider = r.provider;
  if (r.model) out.model = r.model;
  if (r.parentToolCallId) out.parentToolCallId = r.parentToolCallId;
  if (r.parentAgentId) out.parentAgentId = r.parentAgentId;
  if (typeof r.agentDepth === "number") out.agentDepth = r.agentDepth;
  if (r.pastedImages && r.pastedImages.length > 0) out.pastedImages = r.pastedImages;
  if (r.imagePasteIds && r.imagePasteIds.length > 0) out.imagePasteIds = r.imagePasteIds;
  if (r.attachments && r.attachments.length > 0) out.attachments = r.attachments;
  if (r.queueId) out.queueId = r.queueId;
  if (r.isRemote) out.isRemote = true;
  return out;
}

function chainSidecar(r: {
  provider?: string;
  parentToolCallId?: string | undefined;
  parentAgentId?: string | undefined;
  agentDepth?: number | undefined;
  agentModel?: string | undefined;
}): OsSidecar {
  const out: OsSidecar = {};
  if (r.provider) out.provider = r.provider;
  if (r.parentToolCallId) out.parentToolCallId = r.parentToolCallId;
  if (r.parentAgentId) out.parentAgentId = r.parentAgentId;
  if (typeof r.agentDepth === "number") out.agentDepth = r.agentDepth;
  if (r.agentModel) out.agentModel = r.agentModel;
  return out;
}

function assistantSidecar(r: AssistantMessageRecord): OsSidecar {
  const out = chainSidecar(r);
  if (r.producedAccount) out.producedAccount = r.producedAccount;
  const thoughtTokens = r.usage?.thought_tokens ?? 0;
  if (thoughtTokens > 0) out.thoughtTokens = thoughtTokens;
  if (r.usage) out.requestCount = r.usage.request_count;
  return out;
}

function compactionSidecar(r: CompactionMarkRecord): OsSidecar {
  const out: OsSidecar = {};
  if (r.provider) out.provider = r.provider;
  if (r.model) out.model = r.model;
  const compaction: OsCompactionSidecar = { summaryRef: readCompactionSummaryText(r.summary_ref) };
  if (r.version !== undefined) compaction.version = r.version;
  if (r.trigger !== undefined) compaction.trigger = r.trigger;
  if (r.preservedSegment !== undefined) compaction.preservedSegment = r.preservedSegment;
  if (r.preservedMessages !== undefined) compaction.preservedMessages = r.preservedMessages;
  if (r.preTokens !== undefined) compaction.preTokens = r.preTokens;
  if (r.preservedImages !== undefined) compaction.preservedImages = r.preservedImages;
  if (r.error !== undefined) compaction.error = r.error;
  if (r.rapidRefillCount !== undefined) compaction.rapidRefillCount = r.rapidRefillCount;
  if (r.consecutiveFailures !== undefined) compaction.consecutiveFailures = r.consecutiveFailures;
  out.compaction = compaction;
  return out;
}

function assistantMessageShape(
  r: { model?: string; usage?: AssistantRequestUsage },
  uuid: string,
  content: unknown,
): Record<string, unknown> {
  return {
    id: uuid,
    role: "assistant",
    model: r.model ?? SYNTHETIC_MODEL,
    stop_reason: null,
    stop_sequence: null,
    type: "message",
    container: null,
    context_management: null,
    usage: upstreamUsageShape(r.usage),
    content,
  };
}

function upstreamUsageShape(usage: AssistantRequestUsage | undefined): Record<string, unknown> {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
    service_tier: null,
  };
}

function userContentBlocks(r: UserMessageRecord): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (r.content.length > 0) blocks.push({ type: "text", text: r.content });
  if (Array.isArray(r.inlineImages)) blocks.push(...r.inlineImages);
  return blocks;
}

function assistantContentBlocks(r: AssistantMessageRecord): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  if (r.thinking || r.thinkingSignature) {
    blocks.push({
      type: "thinking",
      thinking: r.thinking ?? "",
      ...(r.thinkingSignature ? { signature: r.thinkingSignature } : {}),
    });
  }
  if (r.content.length > 0) blocks.push({ type: "text", text: r.content });
  return blocks;
}
