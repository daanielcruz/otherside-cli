import { summarizeToolInput } from "@/engine/background/workflows/runtime/transcript/summarize.ts";
import type {
  AgentTranscript,
  AgentTranscriptToolUseEntry,
} from "@/engine/background/workflows/runtime/transcript/types.ts";
import StructuredOutputSchema from "@/harness/tools/StructuredOutput/tool.json" with {
  type: "json",
};

interface MutableTranscript {
  agentId: string;
  prompt: string;
  toolCalls: AgentTranscriptToolUseEntry[];
  streamedText: string;
  structuredText: string;
  finalText: string;
}

function freeze(entry: MutableTranscript): AgentTranscript {
  const finalText = entry.finalText.length > 0 ? entry.finalText : entry.structuredText;
  return {
    agentId: entry.agentId,
    prompt: entry.prompt,
    toolCalls: entry.toolCalls.map((call) => ({ name: call.name, summary: call.summary })),
    finalText: finalText.length > 0 ? finalText : entry.streamedText,
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export interface AgentTranscriptStore {
  begin: (agentId: string, prompt: string) => void;
  recordToolCall: (input: { agentId: string; name: string; toolInput: unknown }) => void;
  appendText: (agentId: string, text: string) => void;
  discardText: (agentId: string, chars: number) => void;
  finalize: (agentId: string, finalText: string) => void;
  get: (agentId: string) => AgentTranscript | undefined;
  all: () => AgentTranscript[];
}

export function createAgentTranscriptStore(): AgentTranscriptStore {
  const entries = new Map<string, MutableTranscript>();

  const ensure = (agentId: string): MutableTranscript => {
    const existing = entries.get(agentId);
    if (existing !== undefined) return existing;
    const created: MutableTranscript = {
      agentId,
      prompt: "",
      toolCalls: [],
      streamedText: "",
      structuredText: "",
      finalText: "",
    };
    entries.set(agentId, created);
    return created;
  };

  return {
    begin: (agentId, prompt) => {
      ensure(agentId).prompt = prompt;
    },
    recordToolCall: ({ agentId, name, toolInput }) => {
      const entry = ensure(agentId);
      entry.toolCalls.push({ name, summary: summarizeToolInput(toolInput) });
      if (name === StructuredOutputSchema.name && toolInput !== undefined) {
        entry.structuredText = safeStringify(toolInput);
      }
    },
    appendText: (agentId, text) => {
      ensure(agentId).streamedText += text;
    },
    discardText: (agentId, chars) => {
      // fork_stream_reset: the voided attempt's chars are the streamedText tail.
      if (chars <= 0) return;
      const entry = ensure(agentId);
      entry.streamedText = entry.streamedText.slice(
        0,
        Math.max(0, entry.streamedText.length - chars),
      );
    },
    finalize: (agentId, finalText) => {
      ensure(agentId).finalText = finalText;
    },
    get: (agentId) => {
      const entry = entries.get(agentId);
      return entry !== undefined ? freeze(entry) : undefined;
    },
    all: () => Array.from(entries.values(), freeze),
  };
}
