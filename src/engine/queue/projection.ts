import {
  prefixNotificationForModel,
  wrapNotificationForModel,
} from "@/engine/background/tasks/notification.ts";
import {
  type DrainResult,
  type EmitBoundary,
  type EmitItem,
  ProjectionError,
} from "@/engine/queue/priority.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import type { ContentBlock, ToolResultContentBlock } from "@/kernel/std/types/message.ts";

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
  boundary: EmitBoundary,
): {
  llm: ContentBlock[];
  transcript: TranscriptEntry[];
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

export function projectDrain(items: readonly EmitItem[], boundary: EmitBoundary): DrainResult {
  if (items.length === 0) {
    return {
      llmBlocks: [],
      transcriptEntries: [],
      consumedIds: [],
      notificationTexts: [],
    };
  }
  const llmBlocks: ContentBlock[] = [];
  const transcriptEntries: TranscriptEntry[] = [];
  const consumedIds: string[] = [];
  const notificationTexts: string[] = [];
  for (const item of items) {
    const projected = projectItem(item, boundary);
    if (item.payload.kind === "task_notification_xml" && projected.llm.length > 0) {
      notificationTexts.push(item.payload.text);
    }
    for (const block of projected.llm) llmBlocks.push(block);
    for (const entry of projected.transcript) transcriptEntries.push(entry);
    consumedIds.push(item.id);
  }
  return {
    llmBlocks,
    transcriptEntries,
    consumedIds,
    notificationTexts,
  };
}
