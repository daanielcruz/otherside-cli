import { compactionSummaryRefFromUnknown } from "@/engine/session/compact/summary-spill.ts";
import {
  compactionSummaryFromEnvelope,
  nonNegativeInt,
  objectRecord,
  preservedMessagesFromUnknown,
  preservedSegmentFromUnknown,
  SYNTHETIC_MODEL,
} from "./reader.ts";
import type {
  AssistantMessageRecord,
  AssistantRequestUsage,
  AttachmentRecord,
  CompactionMarkRecord,
  ForeignAttachment,
  GoalStatusAttachment,
  QueuedCommandAttachment,
  SessionRecord,
  Timestamp,
  UpstreamMessageEnvelope,
} from "./schema.ts";
import { nowIso, providerFromModelId } from "./schema.ts";

/**
 * Decodes transcript lines written by a foreign client (no `_os` sidecar):
 * envelope dialect mapping, command-markup stripping, and agent-result folding.
 */

export function recordsFromForeignLine(obj: Record<string, unknown>): SessionRecord[] {
  const env = obj as UpstreamMessageEnvelope;
  const ts = typeof env.timestamp === "string" ? env.timestamp : nowIso();
  if (env.type === "attachment") {
    const attachment = obj.attachment;
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
  if (env.isSidechain === true) return [];
  if (env.isMeta === true) return [];
  if (env.type === "summary") {
    if (typeof env.summary !== "string") return [];
    return [
      { type: "compaction_mark", ts, summary_ref: compactionSummaryRefFromUnknown(env.summary) },
    ];
  }
  if (env.type === "system" && obj.subtype === "compact_boundary") {
    const meta = objectRecord(obj.compactMetadata);
    const rec: CompactionMarkRecord = {
      type: "compaction_mark",
      ts,
      summary_ref: compactionSummaryRefFromUnknown(compactionSummaryFromEnvelope(obj)),
    };
    if (typeof obj.uuid === "string") rec.uuid = obj.uuid;
    if (meta?.trigger === "manual" || meta?.trigger === "auto") rec.trigger = meta.trigger;
    if (typeof meta?.preTokens === "number") rec.preTokens = meta.preTokens;
    const preservedSegment = preservedSegmentFromUnknown(meta?.preservedSegment);
    if (preservedSegment) rec.preservedSegment = preservedSegment;
    const preservedMessages = preservedMessagesFromUnknown(meta?.preservedMessages);
    if (preservedMessages) rec.preservedMessages = preservedMessages;
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
  if (
    content.some(
      (block) => block && typeof block === "object" && (block as { type?: unknown }).type === "pdf",
    )
  ) {
    return content;
  }
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
