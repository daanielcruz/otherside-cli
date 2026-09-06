export interface AgentTranscriptToolUseEntry {
  name: string;
  summary: string;
}

export interface AgentTranscript {
  agentId: string;
  prompt: string;
  toolCalls: AgentTranscriptToolUseEntry[];
  finalText: string;
}
