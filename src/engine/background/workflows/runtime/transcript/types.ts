export interface AgentTranscriptToolCall {
  name: string;
  summary: string;
}

export interface AgentTranscript {
  agentId: string;
  prompt: string;
  toolCalls: AgentTranscriptToolCall[];
  finalText: string;
}
