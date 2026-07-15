import type { ContextUsageData } from "@/engine/session/usage/context.ts";
import type { ToolResultMeta } from "@/kernel/std/types/message.ts";

export type TranscriptKind =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "thinking"
  | "slash_error"
  | "skill"
  | "retry"
  | "compact_done"
  | "command_output"
  | "compaction"
  | "quota_gutter"
  | "api_error"
  | "ask_answer"
  | "task_notice";

export interface NestedToolEntry {
  toolName: string;
  args: unknown;
  running: boolean;
  content?: string;
  isError?: boolean;
}

export type SkillProgressItem =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      toolName: string;
      args: unknown;
      status: "running" | "ok" | "error";
    };

export interface TranscriptImage {
  id?: number;
  mediaType?: string;
  localPath?: string;
}

export type AskAnswerPayload =
  | { declined: true }
  | { declined: false; answers: { question: string; answer: string }[] };

export interface TranscriptEntry {
  id: string;
  kind: TranscriptKind;
  title?: string;
  text: string;
  anchor?: string;
  input?: string;
  isError?: boolean;
  resultMeta?: ToolResultMeta;
  muted?: boolean;
  continuation?: boolean;
  nested?: NestedToolEntry[];
  agentModel?: string;
  producedBy?: string;
  producedModel?: string;
  isBackgrounded?: boolean;
  streaming?: boolean;
  liveOutput?: string;
  skillName?: string;
  progress?: SkillProgressItem[];
  isActive?: boolean;
  startedAt?: number;
  completedAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  images?: TranscriptImage[];
  contextUsage?: ContextUsageData;
  filesRead?: { path: string; numLines: number }[];
  askPayload?: AskAnswerPayload;
}
