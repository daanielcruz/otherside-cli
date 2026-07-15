import {
  INTERRUPT_MESSAGE,
  TOOL_INTERRUPT_MESSAGE,
} from "@/engine/queue/runtime/interruption-text.ts";
import type { AssistantMessageRecord, UserMessageRecord } from "@/engine/session/record/index.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";

export interface InterruptionSnapshot {
  entries: readonly TranscriptEntry[];
  partialText: string;
  committedLen: number;
  streamingId: string | null;
  currentTurnUserId: string | null;
  showFeedback: boolean;
  conversationMarker: boolean;
  partialIdFallback: string;
  interruptId: string;
  provider: string;
  model: string;
  nowIso: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
}

export interface UserMessage {
  role: "user";
  content: ContentBlock[];
}

export interface InterruptionResult {
  nextEntries: TranscriptEntry[];
  assistantMessageToPush: AssistantMessage | null;
  assistantRecordToAppend: AssistantMessageRecord | null;
  userMessageToPush: UserMessage | null;
  userRecordToAppend: UserMessageRecord | null;
}

function markOpenToolEntriesInterrupted(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return entries.map((entry) =>
    entry.kind === "tool" && entry.id.startsWith("t_")
      ? {
          ...entry,
          id: `r_${entry.id.slice(2)}`,
          text: TOOL_INTERRUPT_MESSAGE,
          input: entry.input ?? entry.text,
          isError: true,
        }
      : entry,
  );
}

function hasOpenToolEntries(entries: readonly TranscriptEntry[]): boolean {
  return entries.some((entry) => entry.kind === "tool" && entry.id.startsWith("t_"));
}

export function computeInterruptionResult(snapshot: InterruptionSnapshot): InterruptionResult {
  const {
    entries,
    partialText,
    committedLen,
    streamingId,
    currentTurnUserId,
    showFeedback,
    conversationMarker,
    partialIdFallback,
    interruptId,
    provider,
    model,
    nowIso,
  } = snapshot;

  const hadOpenTool = hasOpenToolEntries(entries);
  const clampedCommittedLen = Math.min(Math.max(0, committedLen), partialText.length);
  const partialDisplayText =
    clampedCommittedLen > 0 ? partialText.slice(clampedCommittedLen) : partialText;
  const hasInterruptedWork = partialText.length > 0 || currentTurnUserId !== null;
  const partialId = streamingId ?? partialIdFallback;

  const nextEntries = markOpenToolEntriesInterrupted(entries);
  if (partialDisplayText.length > 0) {
    nextEntries.push({
      id: partialId,
      kind: "assistant",
      text: partialDisplayText,
      ...(clampedCommittedLen > 0 ? { continuation: true } : {}),
    });
  }
  if (showFeedback && !hadOpenTool && hasInterruptedWork) {
    nextEntries.push({ id: interruptId, kind: "system", text: INTERRUPT_MESSAGE });
  }

  const emitsAssistant = partialText.length > 0 && !hadOpenTool;
  const emitsUser = showFeedback && !hadOpenTool && conversationMarker && hasInterruptedWork;

  return {
    nextEntries,
    assistantMessageToPush: emitsAssistant
      ? { role: "assistant", content: [{ type: "text", text: partialText }] }
      : null,
    assistantRecordToAppend: emitsAssistant
      ? { type: "assistant_message", ts: nowIso, content: partialText, provider, model }
      : null,
    userMessageToPush: emitsUser
      ? { role: "user", content: [{ type: "text", text: INTERRUPT_MESSAGE }] }
      : null,
    userRecordToAppend: emitsUser
      ? {
          type: "user_message",
          ts: nowIso,
          content: INTERRUPT_MESSAGE,
          provider,
          model,
          isMeta: true,
        }
      : null,
  };
}

export interface RestoreUnansweredSnapshot {
  turnHadVisibleOutput: boolean;
  streamingTextLength: number;
  entries: readonly TranscriptEntry[];
  promptTextLength: number;
  queueLength: number;
  currentTurnUserId: string | null;
  currentTurnPrompt: string | null;
}

export type RestoreUnansweredResult =
  | { shouldRestore: false }
  | {
      shouldRestore: true;
      userIdToRemove: string;
      promptToRestore: string;
      resetRenderSurface: boolean;
    };

export function computeRestoreUnansweredResult(
  snapshot: RestoreUnansweredSnapshot,
): RestoreUnansweredResult {
  if (snapshot.turnHadVisibleOutput) return { shouldRestore: false };
  if (snapshot.streamingTextLength > 0) return { shouldRestore: false };
  if (hasOpenToolEntries(snapshot.entries)) return { shouldRestore: false };
  if (snapshot.promptTextLength > 0) return { shouldRestore: false };
  if (snapshot.queueLength > 0) return { shouldRestore: false };
  const userId = snapshot.currentTurnUserId;
  const promptToRestore = snapshot.currentTurnPrompt;
  if (userId === null || promptToRestore === null) return { shouldRestore: false };
  const lastEntry = snapshot.entries[snapshot.entries.length - 1];
  const echoWasSettled = lastEntry?.id !== userId;
  return {
    shouldRestore: true,
    userIdToRemove: userId,
    promptToRestore,
    resetRenderSurface: echoWasSettled,
  };
}
