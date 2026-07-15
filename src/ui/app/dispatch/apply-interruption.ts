import {
  computeInterruptionResult,
  computeRestoreUnansweredResult,
  type InterruptionResult,
  type InterruptionSnapshot,
  type RestoreUnansweredResult,
  type RestoreUnansweredSnapshot,
} from "@/engine/queue/runtime/cancellation.ts";
import {
  appendRecord,
  revokeLastUnansweredUserMessage,
  type Session,
} from "@/engine/session/index.ts";
import type { TranscriptEntry } from "@/ui/transcript/types.ts";

export interface ApplyInterruptionDeps {
  session: Session;
  setTranscript: (value: readonly TranscriptEntry[]) => void;
  setStreamingId: (value: string | null) => void;
  setStreamingText: (value: string) => void;
  setStreamingThinking: (value: string) => void;
  setStreamingCommittedLen: (value: number) => void;
}

export function applyInterruptionResult(
  result: InterruptionResult,
  deps: ApplyInterruptionDeps,
): void {
  deps.setTranscript(result.nextEntries);
  if (result.assistantRecordToAppend !== null) {
    void appendRecord(deps.session, result.assistantRecordToAppend).catch(() => {});
  }
  if (result.assistantMessageToPush !== null) {
    deps.session.messages.push(result.assistantMessageToPush);
  }
  if (result.userMessageToPush !== null) {
    deps.session.messages.push(result.userMessageToPush);
  }
  if (result.userRecordToAppend !== null) {
    void appendRecord(deps.session, result.userRecordToAppend).catch(() => {});
  }
  deps.setStreamingId(null);
  deps.setStreamingText("");
  deps.setStreamingThinking("");
  deps.setStreamingCommittedLen(0);
}

export interface ApplyRestoreUnansweredDeps {
  session: Session;
  entries: readonly TranscriptEntry[];
  setTranscript: (value: readonly TranscriptEntry[]) => void;
  setStreamingId: (value: string | null) => void;
  setStreamingText: (value: string) => void;
  setStreamingThinking: (value: string) => void;
  setStreamingCommittedLen: (value: number) => void;
  setPromptText: (value: string) => void;
  resetRenderSurface: () => void;
}

export function applyRestoreUnansweredResult(
  result: RestoreUnansweredResult,
  deps: ApplyRestoreUnansweredDeps,
): boolean {
  if (!result.shouldRestore) return false;
  revokeLastUnansweredUserMessage(deps.session);
  deps.setTranscript(deps.entries.filter((entry) => entry.id !== result.userIdToRemove));
  deps.setStreamingId(null);
  deps.setStreamingText("");
  deps.setStreamingThinking("");
  deps.setStreamingCommittedLen(0);
  if (result.resetRenderSurface) deps.resetRenderSurface();
  deps.setPromptText(result.promptToRestore);
  return true;
}

export type {
  InterruptionResult,
  InterruptionSnapshot,
  RestoreUnansweredResult,
  RestoreUnansweredSnapshot,
};
export { computeInterruptionResult, computeRestoreUnansweredResult };
