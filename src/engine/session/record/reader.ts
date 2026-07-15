import { compactionSummaryRefFromUnknown } from "@/engine/session/compact/summary-spill.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
import type {
  AssistantMessageRecord,
  AssistantRequestUsage,
  AttachmentRecord,
  CompactionMarkRecord,
  ForeignAttachment,
  GoalStatusAttachment,
  OsSidecar,
  QueuedCommandAttachment,
  RecordType,
  SessionMetaRecord,
  SessionRecord,
  Timestamp,
  UpstreamMessageEnvelope,
  UserMessageRecord,
} from "./schema.ts";
import { KNOWN_TYPES, nowIso, providerFromModelId } from "./schema.ts";

const SYNTHETIC_MODEL = "<synthetic>";

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
    if (type === "attachment") return mapUpstreamRecord(obj);
    if (type && KNOWN_TYPES.has(type as RecordType)) return [obj as unknown as SessionRecord];
    return mapUpstreamRecord(obj);
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
  return {
    type: "session_meta",
    ts,
    cwd: typeof env.cwd === "string" ? env.cwd : "",
    ...(sidecar.provider ? { provider: sidecar.provider } : {}),
    ...(sidecar.model ? { model: sidecar.model } : {}),
    ...(sidecar.effort ? { effort: sidecar.effort } : {}),
    ...(sidecar.fastMode !== undefined ? { fastMode: sidecar.fastMode } : {}),
    ...(sidecar.ultracode !== undefined ? { ultracode: sidecar.ultracode } : {}),
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
        call_id: block.tool_use_id,
        result: block.content ?? "",
        is_error: block.is_error === true,
        ...(sidecar.toolResultMeta ? { meta: sidecar.toolResultMeta } : {}),
        ...(sidecar.agentModel ? { agentModel: sidecar.agentModel } : {}),
        ...common,
      });
    }
  }
  if (out.length > 0) return out;
  const rec: UserMessageRecord = {
    type: "user_message",
    ts,
    ...(typeof env.uuid === "string" ? { uuid: env.uuid } : {}),
    content: textParts.join("\n"),
    ...(typeof env.permissionMode === "string" ? { permissionMode: env.permissionMode } : {}),
    ...(sidecar.provider ? { provider: sidecar.provider } : {}),
    ...(sidecar.model ? { model: sidecar.model } : {}),
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
      out.push({
        type: "tool_call",
        ts,
        tool_name: block.name,
        args: block.input ?? {},
        call_id: block.id,
        ...(sidecar.provider ? { provider: sidecar.provider } : {}),
        ...(model ? { model } : {}),
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
      ...(sidecar.provider ? { provider: sidecar.provider } : {}),
      ...(model ? { model } : {}),
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
      compaction?.summaryRef ?? (typeof env.content === "string" ? env.content : ""),
    ),
  };
  if (sidecar.provider) rec.provider = sidecar.provider;
  if (sidecar.model) rec.model = sidecar.model;
  if (compaction?.version !== undefined) rec.version = compaction.version;
  if (typeof env.logicalParentUuid === "string") rec.leafUuid = env.logicalParentUuid;
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

function nonNegativeInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function mapUpstreamRecord(obj: Record<string, unknown>): SessionRecord[] {
  const env = obj as UpstreamMessageEnvelope;
  const ts = typeof env.timestamp === "string" ? env.timestamp : nowIso();
  if (env.type === "attachment") {
    const attachment = obj.attachment;
    if (!attachment || typeof attachment !== "object") return [];
    const rec: AttachmentRecord = {
      type: "attachment",
      ts,
      attachment: attachment as GoalStatusAttachment | QueuedCommandAttachment | ForeignAttachment,
    };
    if (env.isSidechain === true) rec.isSidechain = true;
    return [rec];
  }
  if (env.isSidechain === true) return [];
  if (env.isMeta === true) return [];
  if (env.type === "summary") {
    if (typeof env.summary !== "string") return [];
    return [
      { type: "compaction_mark", ts, summary_ref: compactionSummaryRefFromUnknown(env.summary) },
    ];
  }
  if (env.type === "system" && obj.subtype === "compact_boundary") {
    const meta = obj.compactMetadata as { trigger?: unknown; preTokens?: unknown } | undefined;
    const rec: CompactionMarkRecord = {
      type: "compaction_mark",
      ts,
      summary_ref: compactionSummaryRefFromUnknown(obj.content),
    };
    if (meta?.trigger === "manual" || meta?.trigger === "auto") rec.trigger = meta.trigger;
    if (typeof meta?.preTokens === "number") rec.preTokens = meta.preTokens;
    if (typeof obj.logicalParentUuid === "string") rec.leafUuid = obj.logicalParentUuid;
    return [rec];
  }
  if (env.type === "user") {
    const content = env.message?.content;
    if (typeof content === "string") {
      const cleaned = stripCommandMarkup(content);
      if (cleaned === null) return [];
      return [{ type: "user_message", ts, content: cleaned }];
    }
    if (Array.isArray(content)) {
      return mapUpstreamUserBlocks(content as Record<string, unknown>[], ts);
    }
    return [];
  }
  if (env.type === "assistant") {
    const content = env.message?.content;
    if (!Array.isArray(content)) return [];
    return mapUpstreamAssistantBlocks(content as Record<string, unknown>[], ts, obj);
  }
  return [];
}

function mapUpstreamUserBlocks(blocks: Record<string, unknown>[], ts: Timestamp): SessionRecord[] {
  const out: SessionRecord[] = [];
  const textParts: string[] = [];
  for (const block of blocks) {
    const t = typeof block.type === "string" ? block.type : null;
    if (t === "text" && typeof block.text === "string") {
      textParts.push(block.text);
      continue;
    }
    if (t === "tool_result") {
      const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      if (!callId) continue;
      const isError = block.is_error === true;
      const result = flattenToolResultContent(block.content);
      out.push({
        type: "tool_result",
        ts,
        call_id: callId,
        result: result ?? "",
        is_error: isError,
      });
    }
  }
  if (textParts.length > 0) {
    const cleaned = stripCommandMarkup(textParts.join("\n"));
    if (cleaned !== null) {
      out.unshift({ type: "user_message", ts, content: cleaned });
    }
  }
  return out;
}

function flattenToolResultContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const obj = block as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") parts.push(obj.text);
  }
  if (parts.length === 0) return content.length === 0 ? content : "";
  const agent = parseAgentResultMeta(parts);
  if (agent !== null) return JSON.stringify(agent);
  return parts.join("\n");
}

const AGENT_USAGE_RE =
  /<usage>\s*total_tokens:\s*(\d+)\s+tool_uses:\s*(\d+)\s+duration_ms:\s*(\d+)\s*<\/usage>/;

function parseAgentResultMeta(parts: string[]): Record<string, unknown> | null {
  const last = parts[parts.length - 1] ?? "";
  if (parts.length === 1 && /Async agent launched successfully/.test(last)) {
    return { status: "backgrounded" };
  }
  const m = last.match(AGENT_USAGE_RE);
  if (!m) return null;
  const tokens = Number(m[1]);
  const toolUses = Number(m[2]);
  const durationMs = Number(m[3]);
  return {
    status: "completed",
    totalToolUseCount: Number.isFinite(toolUses) ? toolUses : 0,
    totalTokens: Number.isFinite(tokens) ? tokens : 0,
    totalDurationMs: Number.isFinite(durationMs) ? durationMs : 0,
  };
}

const COMMAND_NAME_RE = /<command-name>([^<]+)<\/command-name>/i;
const COMMAND_ARGS_RE = /<command-args>([^<]*)<\/command-args>/i;

const STRIPPABLE_BLOCKS: RegExp[] = [
  /<command-message>[\s\S]*?<\/command-message>/gi,
  /<command-args>[\s\S]*?<\/command-args>/gi,
  /<command-stdin>[\s\S]*?<\/command-stdin>/gi,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi,
  /<task-notification>[\s\S]*?<\/task-notification>/gi,
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/gi,
];

export function stripCommandMarkup(text: string): string | null {
  let work = text;
  const nameMatch = work.match(COMMAND_NAME_RE);
  if (nameMatch?.[1]) {
    const argsMatch = work.match(COMMAND_ARGS_RE);
    const cmd = nameMatch[1].trim();
    const args = argsMatch?.[1]?.trim() ?? "";
    const slashLine = args.length > 0 ? `${cmd} ${args}` : cmd;
    work = work.replace(COMMAND_NAME_RE, slashLine);
  }
  for (const re of STRIPPABLE_BLOCKS) work = work.replace(re, "");
  work = work.replace(/\n{3,}/g, "\n\n").trim();
  return work.length === 0 ? null : work;
}

function mapUpstreamAssistantBlocks(
  blocks: Record<string, unknown>[],
  ts: Timestamp,
  envelope?: Record<string, unknown>,
): SessionRecord[] {
  const out: SessionRecord[] = [];
  const textParts: string[] = [];
  let thinking: string | undefined;
  let thinkingSignature: string | undefined;
  const message =
    envelope?.message && typeof envelope.message === "object"
      ? (envelope.message as Record<string, unknown>)
      : undefined;
  const rawModel = typeof message?.model === "string" ? message.model : undefined;
  const model = rawModel === SYNTHETIC_MODEL ? undefined : rawModel;
  const provider = model ? providerFromModelId(model) : undefined;
  for (const block of blocks) {
    const t = typeof block.type === "string" ? block.type : null;
    if (t === "text" && typeof block.text === "string") {
      textParts.push(block.text);
      continue;
    }
    if (t === "thinking" && typeof block.thinking === "string") {
      thinking = thinking ? `${thinking}\n${block.thinking}` : block.thinking;
      if (typeof block.signature === "string" && block.signature.length > 0) {
        thinkingSignature = block.signature;
      }
      continue;
    }
    if (t === "tool_use") {
      const callId = typeof block.id === "string" ? block.id : "";
      const name = typeof block.name === "string" ? block.name : "";
      if (!callId || !name) continue;
      out.push({
        type: "tool_call",
        ts,
        tool_name: name,
        args: block.input ?? {},
        call_id: callId,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      });
    }
  }
  if (textParts.length > 0 || thinking) {
    const joined = textParts.join("\n").trim();
    if (joined.length > 0 && !isApiErrorBlob(joined)) {
      const rec: AssistantMessageRecord = {
        type: "assistant_message",
        ts,
        ...(typeof envelope?.uuid === "string" ? { uuid: envelope.uuid } : {}),
        content: joined,
        ...(thinking ? { thinking } : {}),
        ...(thinkingSignature ? { thinkingSignature } : {}),
        ...(upstreamUsageToStamp(message?.usage) ?? {}),
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      };
      out.unshift(rec);
    }
  }
  return out;
}

function upstreamUsageToStamp(usage: unknown): { usage: AssistantRequestUsage } | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const raw = usage as Record<string, unknown>;
  const stamp: AssistantRequestUsage = {
    input_tokens: nonNegativeInt(raw.input_tokens),
    output_tokens: nonNegativeInt(raw.output_tokens),
    thought_tokens: 0,
    cache_creation_input_tokens: nonNegativeInt(raw.cache_creation_input_tokens),
    cache_read_input_tokens: nonNegativeInt(raw.cache_read_input_tokens),
    request_count: 1,
  };
  const hasTokens =
    stamp.input_tokens > 0 ||
    stamp.output_tokens > 0 ||
    stamp.cache_creation_input_tokens > 0 ||
    stamp.cache_read_input_tokens > 0;
  return hasTokens ? { usage: stamp } : undefined;
}

function isApiErrorBlob(text: string): boolean {
  if (text.length === 0) return false;
  const head = text.slice(0, 200);
  return /^API Error:|"type":"error"|"invalid_request_error"|"overloaded_error"/.test(head);
}
