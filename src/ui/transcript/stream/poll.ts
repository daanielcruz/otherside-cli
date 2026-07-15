import { useEffect, useRef, useState } from "react";
import {
  type BackgroundTask,
  holdTaskEviction,
  subscribe as subscribeBackgroundTasks,
} from "@/engine/background/tasks/background.ts";
import type { SessionRecord } from "@/engine/session/record/index.ts";
import {
  loadSubagentTranscript,
  subagentTranscriptSize,
} from "@/engine/session/transcript/subagent-transcript.ts";
import { useRepeatingClock } from "@/ink";
import { sessionRecordsToTranscript } from "@/ui/transcript/records/from-records.ts";
import type { TranscriptEntry } from "@/ui/transcript/types";

export const AGENT_TRANSCRIPT_POLL_MS = 400;
const EMPTY_AGENT_TRANSCRIPT: TranscriptEntry[] = [];
const EMPTY_AGENT_VIEW = { entries: EMPTY_AGENT_TRANSCRIPT, llmActive: false };

export interface ViewingAgentTranscript {
  entries: TranscriptEntry[];
  llmActive: boolean;
}

export function projectAgentTranscript(
  records: SessionRecord[],
  isRunning: boolean,
): ViewingAgentTranscript {
  const resolved = new Set<string>();
  for (const record of records) if (record.type === "tool_result") resolved.add(record.call_id);
  const hasInFlightCall = records.some(
    (record) => record.type === "tool_call" && !resolved.has(record.call_id),
  );
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
    !hasInFlightCall &&
    lastActivity?.type !== "assistant_message" &&
    lastActivity?.type !== "turn_completion";
  return {
    entries: sessionRecordsToTranscript(records, isRunning, true),
    llmActive,
  };
}

export function useViewingAgentTranscript(input: {
  task: BackgroundTask | undefined;
  sessionId: string;
  cwd: string;
}): ViewingAgentTranscript {
  const { task, sessionId, cwd } = input;
  const taskId = task?.id;
  const forkId = task?.kind === "agent" ? task.forkId : undefined;
  const isRunning = task?.status === "running";
  const [snapshot, setSnapshot] = useState<{
    forkId: string | undefined;
    view: ViewingAgentTranscript;
  }>({ forkId: undefined, view: EMPTY_AGENT_VIEW });
  const sizeRef = useRef(-1);
  const refreshRef = useRef<() => void>(noop);
  useEffect(() => {
    if (taskId === undefined) return;
    return holdTaskEviction(taskId);
  }, [taskId]);
  useEffect(() => {
    sizeRef.current = -1;
    setSnapshot({ forkId, view: EMPTY_AGENT_VIEW });
    refreshRef.current = noop;
    if (forkId === undefined) return;
    let cancelled = false;
    let records: SessionRecord[] = [];
    let hasInFlightCall = false;
    const ref = { cwd, sessionId, forkId };
    const refresh = async (): Promise<void> => {
      const size = await subagentTranscriptSize(ref);
      if (cancelled) return;
      // Unchanged file + in-flight call: rebuild from cached records anyway
      // so the Running… elapsed keeps ticking.
      if (size === sizeRef.current && !(isRunning && hasInFlightCall)) return;
      if (size !== sizeRef.current) {
        sizeRef.current = size;
        records = await loadSubagentTranscript(ref);
        if (cancelled) return;
        const resolved = new Set<string>();
        for (const r of records) if (r.type === "tool_result") resolved.add(r.call_id);
        hasInFlightCall = records.some((r) => r.type === "tool_call" && !resolved.has(r.call_id));
      }
      setSnapshot({ forkId, view: projectAgentTranscript(records, isRunning) });
    };
    refreshRef.current = () => void refresh();
    void refresh();
    const unsub = subscribeBackgroundTasks(() => void refresh());
    return () => {
      cancelled = true;
      refreshRef.current = noop;
      unsub();
    };
  }, [forkId, cwd, sessionId, isRunning]);
  useRepeatingClock(() => refreshRef.current(), isRunning ? AGENT_TRANSCRIPT_POLL_MS : null);
  return snapshot.forkId === forkId ? snapshot.view : EMPTY_AGENT_VIEW;
}

function noop(): void {}
