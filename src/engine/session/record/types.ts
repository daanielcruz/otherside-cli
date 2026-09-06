import type { ContextUsageData } from "@/engine/session/usage/context.ts";
import type { McpCallIdentity } from "@/kernel/mcp/protocol/tool-label.ts";
import type { ToolResultMeta } from "@/kernel/std/types/message.ts";
import type { ProviderId, ProviderModelRoute } from "@/kernel/std/types/provider-ids.ts";

export const TRANSCRIPT_SETTLEMENT_STATES = ["provisional", "mutable-live", "settled"] as const;

export type TranscriptSettlementState = (typeof TRANSCRIPT_SETTLEMENT_STATES)[number];

/** A transcript mutation over the single store SoT. */
export type TranscriptUpdate = (entries: readonly TranscriptEntry[]) => readonly TranscriptEntry[];

/** What `setTranscript` accepts: a full replacement or an updater. */
export type TranscriptWrite = readonly TranscriptEntry[] | TranscriptUpdate;

export type TranscriptKind =
  | "user"
  | "bash_input"
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
  /** Resolved as the row is built, so a folded row names its server as well. */
  mcpIdentity?: McpCallIdentity;
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
  /** Producer-owned lifecycle. Omitted entries retain the v1 compatibility policy. */
  settlementState?: TranscriptSettlementState;
  title?: string;
  text: string;
  anchor?: string;
  input?: string;
  isError?: boolean;
  resultMeta?: ToolResultMeta;
  /** Recorded with an MCP call so its label outlives the server that served it. */
  mcpIdentity?: McpCallIdentity;
  muted?: boolean;
  /** Rendered only on the detailed transcript screen (replayed reasoning). */
  detailOnly?: boolean;
  continuation?: boolean;
  nested?: NestedToolEntry[];
  /** Atomic agent identity when known. Prefer over bare agentModel/agentProvider. */
  agentRoute?: ProviderModelRoute;
  agentModel?: string;
  agentProvider?: ProviderId;
  /** Atomic producer identity when known. Prefer over bare producedBy/producedModel. */
  producedRoute?: ProviderModelRoute;
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
