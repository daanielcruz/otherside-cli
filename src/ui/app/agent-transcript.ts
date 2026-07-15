import type { SetStateAction } from "react";
import * as bgControllers from "@/engine/background/tasks/background-controllers.ts";
import { formatToolInput } from "@/ui/transcript/records/entry-builders.ts";
import type { NestedToolEntry, TranscriptEntry } from "@/ui/transcript/types";

export interface AgentTranscriptDeps {
  setTranscript: (value: SetStateAction<readonly TranscriptEntry[]>) => void;
  agentModelByCallIdRef: { current: Map<string, string> };
}

const MAX_RETAINED_NESTED_TOOL_ENTRIES = 24;

export interface AgentTranscriptHelpers {
  agentBlockText: (toolName: string, callId: string, input: unknown) => string;
  setAgentNested: (
    callId: string,
    mutator: (entries: NestedToolEntry[]) => NestedToolEntry[],
  ) => void;
  setAgentBackgrounded: (callId: string, resolvedModel?: string) => void;
  backgroundCurrentAgent: () => void;
}

function trimNestedEntries(entries: NestedToolEntry[]): NestedToolEntry[] {
  if (entries.length <= MAX_RETAINED_NESTED_TOOL_ENTRIES) return entries;
  const keep = new Set<number>();
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]?.running) keep.add(i);
  }
  for (let i = entries.length - 1; i >= 0 && keep.size < MAX_RETAINED_NESTED_TOOL_ENTRIES; i--) {
    keep.add(i);
  }
  if (keep.size === entries.length) return entries;
  return entries.filter((_, index) => keep.has(index));
}

export function createAgentTranscriptHelpers(deps: AgentTranscriptDeps): AgentTranscriptHelpers {
  const { setTranscript, agentModelByCallIdRef } = deps;

  const agentBlockText = (toolName: string, _callId: string, input: unknown): string => {
    if (toolName !== "Agent") return formatToolInput(input);
    return formatToolInput(input);
  };

  const setAgentNested = (
    callId: string,
    mutator: (entries: NestedToolEntry[]) => NestedToolEntry[],
  ): void => {
    const id = `t_${callId}`;
    setTranscript((t) => {
      const idx = t.findIndex((entry) => entry.id === id);
      if (idx === -1) return t;
      const out = [...t];
      const existing = out[idx];
      if (!existing) return t;
      const nextNested = trimNestedEntries(mutator(existing.nested ?? []));
      out[idx] = { ...existing, nested: nextNested };
      return out;
    });
  };

  const setAgentBackgrounded = (callId: string, resolvedModel?: string): void => {
    const startId = `t_${callId}`;
    const settledId = `b_${callId}`;
    setTranscript((t) => {
      const idx = t.findIndex((entry) => entry.id === startId);
      if (idx === -1) return t;
      const out = [...t];
      const existing = out[idx];
      if (!existing) return t;
      const toolTitle = existing.title ?? "Agent";
      let inputObj: unknown = {};
      if (existing.text.startsWith("{")) {
        try {
          inputObj = JSON.parse(existing.text);
        } catch {}
      }
      const inputRecord = inputObj as Record<string, unknown>;
      const description =
        typeof inputRecord.description === "string" ? inputRecord.description : undefined;
      const stats: Record<string, unknown> = { status: "backgrounded" };
      if (toolTitle === "Agent") {
        const subagentType =
          typeof inputRecord.subagent_type === "string" ? inputRecord.subagent_type : undefined;
        stats.subagent_type = subagentType;
        stats.description = description;
      } else if (toolTitle === "Bash") {
        stats.command = typeof inputRecord.command === "string" ? inputRecord.command : undefined;
        stats.description = description;
      } else {
        stats.description = description;
      }
      out[idx] = {
        id: settledId,
        kind: "tool",
        title: toolTitle,
        text: JSON.stringify(stats),
        ...((resolvedModel ?? existing.agentModel)
          ? { agentModel: resolvedModel ?? existing.agentModel }
          : {}),
        isBackgrounded: true,
      };
      return out;
    });
  };

  const backgroundCurrentAgent = (): void => {
    let backgrounded = false;
    for (const callId of bgControllers.callIds()) {
      const controller = bgControllers.get(callId);
      if (!controller || controller.isBackgrounded()) continue;
      controller.signal();
      setAgentBackgrounded(callId, agentModelByCallIdRef.current.get(callId));
      backgrounded = true;
    }
    if (!backgrounded) return;
  };

  return { agentBlockText, setAgentNested, setAgentBackgrounded, backgroundCurrentAgent };
}
