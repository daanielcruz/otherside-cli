import { wrapNotificationForModel } from "@/engine/background/tasks/notification.ts";
import { buildPostCompactRehydration } from "@/engine/queue/index.ts";
import { readCompactionSummaryText } from "@/engine/session/compact/summary-spill.ts";
import type { AssistantMessageRecord, SessionRecord } from "@/engine/session/record/index.ts";
import { isCompactionBoundary } from "@/engine/session/record/index.ts";
import { usageSnapshotFromAssistantUsage } from "@/engine/session/state.ts";
import {
  formatToolInput,
  taskNotificationFromAttachment,
} from "@/engine/session/transcript/record-format.ts";
import {
  foldTextIntoToolResult,
  isFoldableToolResult,
  type ToolResultBlock,
} from "@/engine/session/transcript/tool-result-fold.ts";
import { getCompactUserSummaryMessage } from "@/harness/routines/compact/index.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { isProviderId } from "@/kernel/config/provider-ids.ts";
import type { ImageDimensions, ImageMediaType } from "@/kernel/std/types/image.ts";
import type {
  ContentBlock,
  Message,
  MessageUsageSnapshot,
  ToolResultContentBlock,
} from "@/kernel/std/types/message.ts";
import { toolResultIsErrorField } from "@/kernel/std/types/message.ts";

export function sessionRecordsToMessages(records: SessionRecord[]): Message[] {
  const replacements = new Map<string, string>();
  for (const record of records) {
    if (record.type === "content_replacement") {
      replacements.set(record.toolUseId, record.replacement);
    }
  }
  const filtered = records.filter((r) => !("isSidechain" in r && r.isSidechain));
  const resultByCallId = new Map<string, ContentBlock>();
  for (const record of filtered) {
    if (record.type !== "tool_result") continue;
    const replacement = replacements.get(record.call_id);
    resultByCallId.set(record.call_id, {
      type: "tool_result",
      tool_use_id: record.call_id,
      content: replacement !== undefined ? replacement : preserveResultBlocks(record.result),
      ...toolResultIsErrorField(record.is_error, record.meta),
    });
  }
  const messages: Message[] = [];
  let pendingToolCalls: { id: string; block: ContentBlock }[] | null = null;
  let pendingAssistantText: ContentBlock[] = [];
  let pendingUserBlocks: ContentBlock[] = [];
  let pendingProducedBy: ProviderId | undefined;
  let pendingProducedModel: string | undefined;
  let pendingProducedAccount: string | undefined;
  let pendingUsage: MessageUsageSnapshot | undefined;
  const flushUserBlocks = (): void => {
    if (pendingUserBlocks.length === 0) return;
    const last = messages[messages.length - 1];
    if (last && last.role === "user" && last.id === undefined) {
      last.content = [...last.content, ...pendingUserBlocks];
    } else {
      messages.push({ role: "user", content: pendingUserBlocks });
    }
    pendingUserBlocks = [];
  };
  const flushAssistantTurn = (): void => {
    const textBlocksToFlush = pendingAssistantText;
    const toolBlocks =
      pendingToolCalls && pendingToolCalls.length > 0
        ? pendingToolCalls.map((entry) => entry.block)
        : [];
    pendingAssistantText = [];
    if (textBlocksToFlush.length > 0 || toolBlocks.length > 0) {
      const last = messages[messages.length - 1];
      const combined = [...textBlocksToFlush, ...toolBlocks];
      if (last && last.role === "assistant") {
        last.content = [...last.content, ...combined];
        if (pendingProducedBy) last.producedBy = pendingProducedBy;
        if (pendingProducedModel) last.producedModel = pendingProducedModel;
        if (pendingProducedAccount) last.producedAccount = pendingProducedAccount;
        if (pendingUsage) last.usage = pendingUsage;
      } else {
        const msg: Message = { role: "assistant", content: combined };
        if (pendingProducedBy) msg.producedBy = pendingProducedBy;
        if (pendingProducedModel) msg.producedModel = pendingProducedModel;
        if (pendingProducedAccount) msg.producedAccount = pendingProducedAccount;
        if (pendingUsage) msg.usage = pendingUsage;
        messages.push(msg);
      }
    }
    pendingProducedBy = undefined;
    pendingProducedModel = undefined;
    pendingProducedAccount = undefined;
    pendingUsage = undefined;
    if (pendingToolCalls && pendingToolCalls.length > 0) {
      for (const entry of pendingToolCalls) {
        const result = resultByCallId.get(entry.id);
        if (result) pendingUserBlocks.push(result);
      }
    }
    pendingToolCalls = null;
  };
  const stampTrailingAssistantUsage = (record: AssistantMessageRecord): void => {
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return;
    if (!last.usage && record.usage) last.usage = usageSnapshotFromAssistantUsage(record.usage);
    if (!last.producedBy && isProviderId(record.provider)) last.producedBy = record.provider;
    if (!last.producedModel && record.model) last.producedModel = record.model;
    if (!last.producedAccount && record.producedAccount)
      last.producedAccount = record.producedAccount;
  };
  for (const record of filtered) {
    if (record.type === "tool_call") {
      if (pendingToolCalls === null) pendingToolCalls = [];
      pendingToolCalls.push({
        id: record.call_id,
        block: {
          type: "tool_use",
          id: record.call_id,
          name: record.tool_name,
          input: record.args,
        },
      });
      continue;
    }
    if (record.type === "tool_result") continue;
    if (record.type === "assistant_message") {
      if (pendingToolCalls && pendingToolCalls.length > 0) flushAssistantTurn();
      const blocks = assistantRecordBlocks(record);
      if (blocks.length === 0) {
        if (pendingAssistantText.length === 0) stampTrailingAssistantUsage(record);
        continue;
      }
      flushUserBlocks();
      pendingAssistantText.push(...blocks);
      if (isProviderId(record.provider)) pendingProducedBy = record.provider;
      if (record.model) pendingProducedModel = record.model;
      if (record.producedAccount) pendingProducedAccount = record.producedAccount;
      if (record.usage) pendingUsage = usageSnapshotFromAssistantUsage(record.usage);
      continue;
    }
    flushAssistantTurn();
    if (record.type === "user_message") {
      const baseBlocks = textBlocks(record.content);
      const imageBlocks = Array.isArray(record.inlineImages) ? record.inlineImages : [];
      const merged: ContentBlock[] = [...baseBlocks, ...imageBlocks];
      if (merged.length > 0 && record.queueId !== undefined) {
        flushUserBlocks();
        messages.push({ role: "user", content: merged, id: record.queueId });
      } else {
        if (merged.length > 0) pendingUserBlocks.push(...merged);
        flushUserBlocks();
      }
    } else if (record.type === "attachment") {
      const notification = taskNotificationFromAttachment(record.attachment);
      if (notification !== null) {
        const notifText = wrapNotificationForModel(notification);
        const target = trailingToolResult(pendingUserBlocks, messages);
        if (target !== null) {
          foldTextIntoToolResult(target, notifText);
        } else {
          pendingUserBlocks.push({ type: "text", text: notifText });
        }
        flushUserBlocks();
      }
    } else if (record.type === "compaction_mark") {
      if (!isCompactionBoundary(record)) continue;
      flushUserBlocks();
      messages.length = 0;
      pendingToolCalls = null;
      pendingAssistantText = [];
      pendingUserBlocks = [];
      pendingProducedBy = undefined;
      pendingProducedModel = undefined;
      pendingUsage = undefined;
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: getCompactUserSummaryMessage(readCompactionSummaryText(record.summary_ref)),
          },
        ],
      });
      const preserved = Array.isArray(record.preservedImages) ? record.preservedImages : [];
      const { blocks: rehydrationBlocks } = buildPostCompactRehydration("default", preserved);
      if (rehydrationBlocks.length > 0) {
        messages.push({ role: "user", content: rehydrationBlocks });
      }
    }
  }
  flushAssistantTurn();
  flushUserBlocks();
  return padOrphanToolCalls(coalesceConsecutiveSameRole(messages));
}

function coalesceConsecutiveSameRole(messages: Message[]): Message[] {
  if (messages.length < 2) return messages;
  const out: Message[] = [];
  for (const msg of messages) {
    const last = out[out.length - 1];
    if (last && last.role === msg.role && last.id === undefined && msg.id === undefined) {
      out[out.length - 1] = {
        ...last,
        content: [...last.content, ...msg.content],
      };
    } else {
      out.push(msg);
    }
  }
  return out;
}

function padOrphanToolCalls(messages: Message[]): Message[] {
  const declaredToolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") declaredToolUseIds.add(block.id);
    }
  }
  const filtered: Message[] = [];
  for (const msg of messages) {
    if (msg.role !== "user") {
      filtered.push(msg);
      continue;
    }
    const kept = msg.content.filter(
      (block) => block.type !== "tool_result" || declaredToolUseIds.has(block.tool_use_id),
    );
    if (kept.length > 0) filtered.push({ ...msg, content: kept });
  }
  const resolved = new Set<string>();
  for (const msg of filtered) {
    for (const block of msg.content) {
      if (block.type === "tool_result") resolved.add(block.tool_use_id);
    }
  }
  const out: Message[] = [];
  for (let idx = 0; idx < filtered.length; idx++) {
    const msg = filtered[idx];
    if (msg === undefined) continue;
    if (msg.role !== "assistant") {
      out.push(msg);
      continue;
    }
    out.push(msg);
    const orphans: string[] = [];
    for (const block of msg.content) {
      if (block.type === "tool_use" && !resolved.has(block.id)) {
        orphans.push(block.id);
        resolved.add(block.id);
      }
    }
    if (orphans.length === 0) continue;
    const orphanBlocks = orphans.map((id) => ({
      type: "tool_result" as const,
      tool_use_id: id,
      content: "Interrupted by user",
      is_error: true,
    }));
    const next = filtered[idx + 1];
    if (next && next.role === "user") {
      out.push({ ...next, content: [...orphanBlocks, ...next.content] });
      idx += 1;
    } else {
      out.push({ role: "user", content: orphanBlocks });
    }
  }
  return out;
}

function textBlocks(text: string): ContentBlock[] {
  return text.length > 0 ? [{ type: "text", text }] : [];
}

function assistantRecordBlocks(record: AssistantMessageRecord): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const thinking = record.thinking ?? "";
  const signature = record.thinkingSignature ?? "";
  if (thinking.length > 0 || signature.length > 0) {
    // The block carries the record's provenance: adjacent assistant messages
    // can merge during rebuild, and a merged message's stamp must not vouch
    // for a sibling producer's signed reasoning.
    blocks.push({
      type: "thinking",
      text: thinking,
      ...(signature ? { signature } : {}),
      ...(isProviderId(record.provider) ? { producedBy: record.provider } : {}),
      ...(record.model ? { producedModel: record.model } : {}),
      ...(record.producedAccount ? { producedAccount: record.producedAccount } : {}),
    });
  }
  blocks.push(...textBlocks(record.content));
  return blocks;
}

// Locate the tool_result a trailing sibling (a background-task notification)
// should fold into: the last block still pending, or — once those flushed — the
// last block of the current user message. Null when there is nothing to fold
// into (the sibling then stands alone as its own text block).
function trailingToolResult(pending: ContentBlock[], messages: Message[]): ToolResultBlock | null {
  const candidate =
    pending.length > 0 ? pending[pending.length - 1] : lastUserMessageTailBlock(messages);
  return isFoldableToolResult(candidate) ? candidate : null;
}

function lastUserMessageTailBlock(messages: Message[]): ContentBlock | undefined {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return undefined;
  return last.content[last.content.length - 1];
}

function preserveResultBlocks(result: unknown): string | ToolResultContentBlock[] {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    const blocks: ToolResultContentBlock[] = [];
    let valid = true;
    for (const item of result) {
      if (!item || typeof item !== "object") {
        valid = false;
        break;
      }
      const obj = item as Record<string, unknown>;
      if (obj.type === "text" && typeof obj.text === "string") {
        blocks.push({ type: "text", text: obj.text });
      } else if (obj.type === "image" && obj.source && typeof obj.source === "object") {
        const src = obj.source as Record<string, unknown>;
        if (
          src.type === "base64" &&
          typeof src.media_type === "string" &&
          typeof src.data === "string" &&
          src.data.length > 0
        ) {
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: src.media_type as ImageMediaType,
              data: src.data,
            },
            ...(obj.dimensions && typeof obj.dimensions === "object"
              ? { dimensions: obj.dimensions as ImageDimensions }
              : {}),
          });
        } else {
          valid = false;
          break;
        }
      } else if (obj.type === "pdf" && obj.source && typeof obj.source === "object") {
        const src = obj.source as Record<string, unknown>;
        if (
          src.type === "base64" &&
          src.media_type === "application/pdf" &&
          typeof src.data === "string" &&
          src.data.length > 0 &&
          typeof obj.filename === "string" &&
          typeof obj.pageCount === "number" &&
          typeof obj.bytes === "number"
        ) {
          blocks.push({
            type: "pdf",
            source: { type: "base64", media_type: "application/pdf", data: src.data },
            filename: obj.filename,
            pageCount: obj.pageCount,
            bytes: obj.bytes,
          });
        } else {
          valid = false;
          break;
        }
      } else {
        valid = false;
        break;
      }
    }
    if (valid && blocks.length > 0) return blocks;
  }
  return formatToolInput(result);
}
