import { TOOL_INTERRUPT_MESSAGE } from "@/engine/queue/runtime/interruption-text.ts";
import { parseBashTurnText } from "@/engine/queue/turn/bash-input.ts";
import { isCompactionBoundary, type SessionRecord } from "@/engine/session/index.ts";
import {
  formatElapsed,
  formatTurnDuration,
  TURN_COMPLETION_VERB,
} from "@/ui/chrome/progress/index.ts";
import {
  askAnswerEntry,
  augmentAgentResult,
  formatHookEventForReplay,
  formatToolInput,
  resultToText,
  stripControlPlaneMarkup,
  taskNoticeReplayTextFromNotification,
  taskNoticeTextFromNotification,
  taskNotificationFromAttachment,
  transcriptImagesFromRecord,
} from "@/ui/transcript/records/entry-builders.ts";
import type { TranscriptEntry } from "@/ui/transcript/types";

export const SILENT_TOOL_NAMES = new Set([
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "ToolSearch",
]);

export interface TranscriptProjectionOptions {
  isRunning?: boolean;
  includeProducerMetadata?: boolean;
  includeThinking?: boolean;
}

export function sessionRecordsToTranscript(
  records: SessionRecord[],
  options: TranscriptProjectionOptions = {},
): TranscriptEntry[] {
  const { isRunning = false, includeProducerMetadata = false, includeThinking = false } = options;
  const replacements = new Map<string, string>();
  for (const record of records) {
    if (record.type === "content_replacement") {
      replacements.set(record.toolUseId, record.replacement);
    }
  }
  const filtered = records.filter((r) => !("isSidechain" in r && r.isSidechain));
  const resolvedCallIds = new Set<string>();
  for (const record of filtered) {
    if (record.type === "tool_result") resolvedCallIds.add(record.call_id);
  }
  const callByCallId = new Map<
    string,
    { name: string; args: unknown; provider?: string; model?: string }
  >();
  // A background agent's tool result is only the launch receipt; its real
  // outcome arrives later as a task-notification record. Index those by task
  // id so a replayed receipt can show the completion the live view showed.
  const notificationByTaskId = new Map<string, string>();
  for (const record of filtered) {
    if (record.type !== "attachment") continue;
    const notification = taskNotificationFromAttachment(record.attachment);
    if (notification === null) continue;
    const taskId = notification.match(/<task-id>([^<]+)<\/task-id>/)?.[1]?.trim();
    if (taskId) notificationByTaskId.set(taskId, notification);
  }
  const silentCallIds = new Set<string>();
  for (const record of filtered) {
    if (record.type === "tool_call") {
      callByCallId.set(record.call_id, {
        name: record.tool_name,
        args: record.args,
        ...(record.provider ? { provider: record.provider } : {}),
        ...(record.model ? { model: record.model } : {}),
      });
      if (SILENT_TOOL_NAMES.has(record.tool_name)) silentCallIds.add(record.call_id);
    }
  }
  const entries: TranscriptEntry[] = [];
  filtered.forEach((record, index) => {
    const id = `rec_${index}`;
    if (record.type === "user_message") {
      if (record.content.trimStart().startsWith("<task-notification>")) {
        entries.push({
          id,
          kind: "task_notice",
          text: taskNoticeReplayTextFromNotification(record.content),
          isError: /<status>(?:error|failed)<\/status>/.test(record.content),
        });
        return;
      }
      const bashTurn = parseBashTurnText(record.content);
      if (bashTurn !== null) {
        entries.push({
          id,
          kind: "bash_input",
          text: bashTurn.command,
          resultMeta: {
            kind: "bash",
            status: "completed",
            // The persisted turn text carries no exit code; stderr-only output
            // still renders through the gutter either way.
            exit_code: 0,
            stdout: bashTurn.stdout,
            stderr: bashTurn.stderr,
          },
        });
        return;
      }
      const cleaned = stripControlPlaneMarkup(record.content);
      const images = transcriptImagesFromRecord(record);
      if (cleaned.length === 0 && images.length === 0) return;
      entries.push({
        id,
        kind: "user",
        text: cleaned,
        ...(typeof record.uuid === "string" ? { anchor: record.uuid } : {}),
        ...(images.length > 0 ? { images } : {}),
      });
      return;
    }
    if (record.type === "assistant_message") {
      const thinking = record.thinking;
      const hasThinking = typeof thinking === "string" && thinking.trim().length > 0;
      const hasContent = record.content.trim().length > 0;
      if (!hasThinking && !hasContent) return;
      const producer = includeProducerMetadata
        ? {
            ...(record.provider ? { producedBy: record.provider } : {}),
            ...(record.model ? { producedModel: record.model } : {}),
          }
        : {};
      if (hasThinking && includeThinking) {
        entries.push({ id: `${id}_th`, kind: "thinking", text: thinking, ...producer });
      }
      if (hasContent) {
        entries.push({ id, kind: "assistant", text: record.content, ...producer });
      }
      return;
    }
    if (record.type === "tool_call") {
      if (resolvedCallIds.has(record.call_id) || silentCallIds.has(record.call_id)) return;
      const inputText = formatToolInput(record.args);
      // In a live view an unresolved call is in flight — show its elapsed
      // runtime like any running tool; in a replay it was interrupted.
      const startedMs = Date.parse(record.ts);
      const running =
        isRunning && Number.isFinite(startedMs)
          ? `Running… (${formatElapsed(Date.now() - startedMs)})`
          : "";
      entries.push({
        id: `r_${record.call_id}`,
        kind: "tool",
        title: record.tool_name,
        text: isRunning ? running : TOOL_INTERRUPT_MESSAGE,
        isError: !isRunning,
        ...(inputText.length > 0 ? { input: inputText } : {}),
        ...(includeProducerMetadata && record.provider ? { producedBy: record.provider } : {}),
        ...(includeProducerMetadata && record.model ? { producedModel: record.model } : {}),
      });
      return;
    }
    if (record.type === "tool_result") {
      const askCall = callByCallId.get(record.call_id);
      const replacement = replacements.get(record.call_id);
      if (askCall?.name === "AskUserQuestion") {
        const askEntry = askAnswerEntry(
          replacement !== undefined ? replacement : resultToText(record.result),
          `aq_${record.call_id}`,
          record.meta,
        );
        if (askEntry) entries.push(askEntry);
        return;
      }
      if (silentCallIds.has(record.call_id)) return;
      const call = callByCallId.get(record.call_id);
      const toolName = call?.name ?? "Tool";
      const inputText = call ? formatToolInput(call.args) : "";
      let resultText: string;
      let noticeError: boolean | undefined;
      if (replacement !== undefined) {
        resultText = replacement;
      } else if (toolName === "Agent" && call) {
        resultText = augmentAgentResult(resultToText(record.result), call.args);
        const receiptAgentId = launchReceiptAgentId(resultText);
        const notification =
          receiptAgentId === null ? undefined : notificationByTaskId.get(receiptAgentId);
        if (notification !== undefined) {
          resultText = taskNoticeTextFromNotification(notification);
          noticeError = /<status>(?:error|failed)<\/status>/.test(notification);
        }
      } else {
        resultText = resultToText(record.result);
      }
      entries.push({
        id: `r_${record.call_id}`,
        kind: "tool",
        title: toolName,
        text: resultText,
        isError: noticeError ?? record.is_error,
        ...(inputText.length > 0 ? { input: inputText } : {}),
        ...(record.meta ? { resultMeta: record.meta } : {}),
        ...(record.agentModel ? { agentModel: record.agentModel } : {}),
        ...(includeProducerMetadata && call?.provider ? { producedBy: call.provider } : {}),
        ...(includeProducerMetadata && call?.model ? { producedModel: call.model } : {}),
      });
      return;
    }
    if (record.type === "attachment") {
      const notification = taskNotificationFromAttachment(record.attachment);
      if (notification !== null) {
        entries.push({
          id,
          kind: "task_notice",
          text: taskNoticeReplayTextFromNotification(notification),
          isError: /<status>(?:error|failed)<\/status>/.test(notification),
        });
      }
      return;
    }
    if (record.type === "hook_event") {
      const formatted = formatHookEventForReplay(record);
      if (formatted) {
        entries.push({ id, kind: "system", text: formatted });
      }
      return;
    }
    if (record.type === "compaction_mark") {
      if (isCompactionBoundary(record)) {
        entries.push({
          id,
          kind: "compaction",
          text: "Conversation compacted",
          muted: true,
        });
      } else {
        entries.push({
          id,
          kind: "compaction",
          text: record.error
            ? `Conversation compact failed — ${record.error}`
            : "Conversation compact failed",
          muted: true,
          isError: true,
        });
      }
      return;
    }
    if (record.type === "turn_completion") {
      entries.push({
        id,
        kind: "compact_done",
        text: `${TURN_COMPLETION_VERB} for ${formatTurnDuration(record.durationMs)}`,
        muted: true,
      });
    }
  });
  return entries;
}

// The receipt a background launch returns as its tool result; the agent id it
// names is the task id its completion notification will carry.
function launchReceiptAgentId(resultText: string): string | null {
  if (!resultText.startsWith("Async agent launched successfully")) return null;
  return resultText.match(/^agentId:\s*(\S+)/m)?.[1] ?? null;
}
