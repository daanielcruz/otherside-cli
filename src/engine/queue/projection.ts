import {
  prefixNotificationForModel,
  wrapNotificationForModel,
} from "@/engine/background/tasks/notification.ts";
import {
  type BoundaryPolicy,
  type DrainResult,
  type EmitBoundary,
  type EmitItem,
  ProjectionError,
  type QueuedMessageLookup,
} from "@/engine/queue/priority.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import type { ContentBlock, ToolResultContentBlock } from "@/kernel/std/types/message.ts";

const SYSTEM_REMINDER_HEADER =
  "<system-reminder>\nAdditional user messages arrived while you were working. Address them, but do not abandon the original task unless a new message clearly redirects or cancels it. After handling any side question, continue the original work.\n</system-reminder>";

function wantsLlm(item: EmitItem): boolean {
  return item.target === "llm_request" || item.target === "both";
}

function wantsTranscript(item: EmitItem): boolean {
  return item.target === "transcript" || item.target === "both";
}

function transcriptIdFor(item: EmitItem, suffix?: string): string {
  return suffix === undefined ? `eq_${item.id}` : `eq_${item.id}_${suffix}`;
}

function projectToolResult(item: EmitItem & { payload: { kind: "tool_result" } }): {
  llm: ContentBlock[];
  transcript: TranscriptEntry[];
} {
  const llm: ContentBlock[] = wantsLlm(item)
    ? [
        {
          type: "tool_result",
          tool_use_id: item.payload.toolUseId,
          content:
            typeof item.payload.content === "string"
              ? item.payload.content
              : (item.payload.content as unknown as ToolResultContentBlock[]),
          ...(item.payload.isError === true ? { is_error: true } : {}),
        },
      ]
    : [];
  return { llm, transcript: [] };
}

function projectToolResultInterrupt(
  item: EmitItem & { payload: { kind: "tool_result_interrupt" } },
): { llm: ContentBlock[]; transcript: TranscriptEntry[] } {
  const llm: ContentBlock[] = wantsLlm(item)
    ? [
        {
          type: "tool_result",
          tool_use_id: item.payload.toolUseId,
          content: item.payload.content,
          is_error: true,
        },
      ]
    : [];
  const transcript: TranscriptEntry[] = wantsTranscript(item)
    ? [
        {
          id: transcriptIdFor(item),
          kind: "system",
          text: item.payload.content,
        },
      ]
    : [];
  return { llm, transcript };
}

function projectTaskNotification(
  item: EmitItem & { payload: { kind: "task_notification_xml" } },
  boundary: EmitBoundary,
): {
  llm: ContentBlock[];
  transcript: TranscriptEntry[];
} {
  // Fresh-turn delivery rides a plain prefixed user message; a notification
  // folded into a running turn carries the reminder envelope so it reads as
  // out-of-band next to tool results.
  const wrap = boundary === "turn_start" ? prefixNotificationForModel : wrapNotificationForModel;
  const llm: ContentBlock[] = wantsLlm(item)
    ? [{ type: "text", text: wrap(item.payload.text) }]
    : [];
  const summary = item.payload.summary ?? item.payload.text;
  const transcript: TranscriptEntry[] = wantsTranscript(item)
    ? [
        {
          id: transcriptIdFor(item),
          kind: "task_notice",
          text: summary,
          ...(item.payload.isError === true ? { isError: true } : {}),
        },
      ]
    : [];
  return { llm, transcript };
}

function projectQueuedMessage(
  item: EmitItem & { payload: { kind: "queued_message" } },
  lookup: QueuedMessageLookup,
): {
  llm: ContentBlock[];
  transcript: TranscriptEntry[];
  queuedMessageId: string;
} {
  const msg = lookup(item.payload.queuedMessageId);
  if (msg === undefined) {
    return { llm: [], transcript: [], queuedMessageId: item.payload.queuedMessageId };
  }
  const blocks: ContentBlock[] =
    msg.blocks !== undefined && msg.blocks.length > 0
      ? msg.blocks
      : [{ type: "text", text: msg.expanded }];
  const llm: ContentBlock[] = wantsLlm(item) ? blocks : [];
  const transcript: TranscriptEntry[] = wantsTranscript(item)
    ? [
        {
          id: transcriptIdFor(item),
          kind: "user",
          text: msg.expanded,
          ...(msg.pastedImages !== undefined && msg.pastedImages.length > 0
            ? {
                images: msg.pastedImages.map((img) => ({
                  id: img.id,
                  mediaType: img.mediaType,
                  ...(img.localPath !== undefined ? { localPath: img.localPath } : {}),
                })),
              }
            : {}),
        },
      ]
    : [];
  return { llm, transcript, queuedMessageId: msg.id };
}

function projectUserInterruptMessage(
  item: EmitItem & { payload: { kind: "user_interrupt_message" } },
): { llm: ContentBlock[]; transcript: TranscriptEntry[] } {
  const llm: ContentBlock[] = wantsLlm(item) ? [{ type: "text", text: item.payload.text }] : [];
  const transcript: TranscriptEntry[] = wantsTranscript(item)
    ? [
        {
          id: transcriptIdFor(item),
          kind: "system",
          text: item.payload.text,
        },
      ]
    : [];
  return { llm, transcript };
}

function projectForkEvent(item: EmitItem & { payload: { kind: "fork_event" } }): {
  llm: ContentBlock[];
  transcript: TranscriptEntry[];
} {
  void item;
  return { llm: [], transcript: [] };
}

function projectItem(
  item: EmitItem,
  lookup: QueuedMessageLookup,
  boundary: EmitBoundary,
): {
  llm: ContentBlock[];
  transcript: TranscriptEntry[];
  queuedMessageId?: string;
} {
  switch (item.payload.kind) {
    case "tool_result":
      return projectToolResult(item as EmitItem & { payload: { kind: "tool_result" } });
    case "tool_result_interrupt":
      return projectToolResultInterrupt(
        item as EmitItem & { payload: { kind: "tool_result_interrupt" } },
      );
    case "task_notification_xml":
      return projectTaskNotification(
        item as EmitItem & { payload: { kind: "task_notification_xml" } },
        boundary,
      );
    case "queued_message":
      return projectQueuedMessage(
        item as EmitItem & { payload: { kind: "queued_message" } },
        lookup,
      );
    case "user_interrupt_message":
      return projectUserInterruptMessage(
        item as EmitItem & { payload: { kind: "user_interrupt_message" } },
      );
    case "fork_event":
      return projectForkEvent(item as EmitItem & { payload: { kind: "fork_event" } });
    default:
      throw new ProjectionError(
        `unknown EmitPayload kind: ${(item.payload as { kind: string }).kind}`,
        item,
      );
  }
}

export function projectDrain(
  items: readonly EmitItem[],
  boundary: EmitBoundary,
  policy: BoundaryPolicy,
  lookup: QueuedMessageLookup,
): DrainResult {
  if (items.length === 0) {
    return {
      llmBlocks: [],
      transcriptEntries: [],
      consumedIds: [],
      removedQueuedMessageIds: [],
      notificationTexts: [],
    };
  }
  const llmBlocks: ContentBlock[] = [];
  const transcriptEntries: TranscriptEntry[] = [];
  const consumedIds: string[] = [];
  const queuedMessageIdsToRemove: string[] = [];
  const notificationTexts: string[] = [];
  let needsSystemReminder = false;
  for (const item of items) {
    const projected = projectItem(item, lookup, boundary);
    if (policy.wrapSystemReminder === true && projected.llm.length > 0) {
      // task_notification_xml carries its own system-reminder envelope.
      if (item.payload.kind === "queued_message") {
        needsSystemReminder = true;
      }
    }
    if (item.payload.kind === "task_notification_xml" && projected.llm.length > 0) {
      notificationTexts.push(item.payload.text);
    }
    for (const block of projected.llm) llmBlocks.push(block);
    for (const entry of projected.transcript) transcriptEntries.push(entry);
    if (projected.queuedMessageId !== undefined) {
      queuedMessageIdsToRemove.push(projected.queuedMessageId);
    }
    consumedIds.push(item.id);
  }
  if (needsSystemReminder && llmBlocks.length > 0) {
    llmBlocks.unshift({ type: "text", text: SYSTEM_REMINDER_HEADER });
  }
  return {
    llmBlocks,
    transcriptEntries,
    consumedIds,
    removedQueuedMessageIds: queuedMessageIdsToRemove,
    notificationTexts,
  };
}
