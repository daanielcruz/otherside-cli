import type { SessionRecord } from "@/engine/session/record/index.ts";
import { sessionRecordsToTranscript } from "@/ui/transcript/records/from-records.ts";
import type { TranscriptEntry } from "@/ui/transcript/types";

export interface AgentTranscriptView {
  readonly entries: TranscriptEntry[];
  /** The agent is waiting on the model rather than on a tool it already called. */
  readonly llmActive: boolean;
}

export const EMPTY_AGENT_TRANSCRIPT: AgentTranscriptView = { entries: [], llmActive: false };

export function hasInFlightToolCall(records: readonly SessionRecord[]): boolean {
  const resolved = new Set<string>();
  for (const record of records) {
    if (record.type === "tool_result") resolved.add(record.call_id);
  }
  return records.some((record) => record.type === "tool_call" && !resolved.has(record.call_id));
}

/**
 * Turn an agent's own session records into the entries its document shows. Tool calls
 * whose child agent is still running are marked backgrounded so the row reads as live
 * work rather than a finished step.
 */
export function projectAgentTranscript(
  records: SessionRecord[],
  isRunning: boolean,
  runningChildCallIds?: ReadonlySet<string>,
): AgentTranscriptView {
  const lastActivity = records.findLast(
    (record) =>
      record.type === "user_message" ||
      record.type === "assistant_message" ||
      record.type === "tool_call" ||
      record.type === "tool_result" ||
      record.type === "turn_completion",
  );
  const llmActive =
    isRunning &&
    !hasInFlightToolCall(records) &&
    lastActivity?.type !== "assistant_message" &&
    lastActivity?.type !== "turn_completion";
  const entries = sessionRecordsToTranscript(records, {
    isRunning,
    includeProducerMetadata: true,
    includeThinking: true,
  });
  if (runningChildCallIds !== undefined && runningChildCallIds.size > 0) {
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (entry?.kind !== "tool" || !entry.id.startsWith("r_")) continue;
      if (!runningChildCallIds.has(entry.id.slice(2))) continue;
      entries[index] = { ...entry, isBackgrounded: true };
    }
  }
  return { entries, llmActive };
}
