import type { CompactionSummaryRef } from "@/engine/session/compact/summary-spill.ts";
import { isTruthyCompactionSummaryRef } from "@/engine/session/compact/summary-spill.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { ContentBlock, ToolResultMeta } from "@/kernel/std/types/message.ts";

export type Timestamp = string;

export type RecordType =
  | "session_meta"
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "hook_event"
  | "usage"
  | "compaction_mark"
  | "injection_queued"
  | "attachment"
  | "turn_completion"
  | "content_replacement"
  | "worktree_state";

export interface SessionMetaRecord {
  type: "session_meta";
  ts: Timestamp;
  cwd: string;
  provider?: string;
  model?: string;
  effort?: string;
  fastMode?: boolean;
  ultracode?: boolean;
}

export interface UserMessagePastedImage {
  id: number;
  data: string;
  mediaType: string;
}

export interface UserMessageRecord {
  type: "user_message";
  ts: Timestamp;
  uuid?: string;
  content: string;
  provider?: string;
  model?: string;
  permissionMode?: string;
  pastedImages?: UserMessagePastedImage[];
  imagePasteIds?: number[];
  inlineImages?: ContentBlock[];
  attachments?: unknown[];
  queueId?: string;
  entrypoint?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  parentToolCallId?: string | undefined;
  parentAgentId?: string | undefined;
  agentDepth?: number | undefined;
  agentId?: string | undefined;
  isRemote?: boolean;
}

export interface AssistantRequestUsage {
  input_tokens: number;
  output_tokens: number;
  thought_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  request_count: number;
}

export interface AssistantMessageRecord {
  type: "assistant_message";
  ts: Timestamp;
  uuid?: string;
  content: string;
  thinking?: string;
  thinkingSignature?: string;
  usage?: AssistantRequestUsage;
  provider?: string;
  model?: string;
  producedAccount?: string;
  entrypoint?: string;
  requestId?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  parentToolCallId?: string | undefined;
  parentAgentId?: string | undefined;
  agentDepth?: number | undefined;
  agentId?: string | undefined;
}

export interface ToolCallRecord {
  type: "tool_call";
  ts: Timestamp;
  uuid?: string;
  tool_name: string;
  args: unknown;
  call_id: string;
  provider?: string;
  model?: string;
  isSidechain?: boolean;
  parentToolCallId?: string | undefined;
  parentAgentId?: string | undefined;
  agentDepth?: number | undefined;
  agentId?: string | undefined;
}

export interface ToolResultRecord {
  type: "tool_result";
  ts: Timestamp;
  uuid?: string;
  call_id: string;
  result: unknown;
  is_error: boolean;
  toolUseResult?: unknown;
  meta?: ToolResultMeta;
  agentModel?: string;
  isSidechain?: boolean;
  parentToolCallId?: string | undefined;
  parentAgentId?: string | undefined;
  agentDepth?: number | undefined;
  agentId?: string | undefined;
}

export interface HookEventRecord {
  type: "hook_event";
  ts: Timestamp;
  kind: string;
  payload: unknown;
  isSidechain?: boolean;
  parentToolCallId?: string | undefined;
  parentAgentId?: string | undefined;
  agentDepth?: number | undefined;
  agentId?: string | undefined;
}

export interface UsageRecord {
  type: "usage";
  ts: Timestamp;
  provider: ProviderId;
  model: string;
  session_id: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  thought_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  estimated?: boolean | undefined;
  isSidechain?: boolean;
  parentToolCallId?: string | undefined;
  parentAgentId?: string | undefined;
  agentDepth?: number | undefined;
  agentId?: string | undefined;
}

export interface PreservedSegment {
  headUuid: string;
  tailUuid: string;
  anchorUuid: string;
}

export interface PreservedMessages {
  uuids: string[];
  anchorUuid: string;
}

export interface CompactionMarkRecord {
  type: "compaction_mark";
  ts: Timestamp;
  uuid?: string;
  summary_ref: CompactionSummaryRef;
  provider?: string;
  model?: string;
  version?: number;
  leafUuid?: string;
  preservedSegment?: PreservedSegment;
  preservedMessages?: PreservedMessages;
  preTokens?: number;
  trigger?: "auto" | "manual" | "rapid_refill_trip" | "circuit_breaker_trip" | "auto_failure";
  preservedImages?: ContentBlock[];
  error?: string;
  rapidRefillCount?: number;
  consecutiveFailures?: number;
}

export function isCompactionBoundary(record: CompactionMarkRecord): boolean {
  return isTruthyCompactionSummaryRef(record.summary_ref);
}

export interface InjectionQueuedRecord {
  type: "injection_queued";
  ts: Timestamp;
  text: string;
  source?: string;
}

export interface QueuedCommandAttachment {
  type: "queued_command";
  prompt: string;
  commandMode?: "prompt" | "task-notification";
  isMeta?: boolean;
}

export interface GoalStatusAttachment {
  type: "goal_status";
  condition: string;
  met?: boolean;
  cleared?: boolean;
  reason?: string;
  iteration?: number;
}

export interface ForeignAttachment {
  type: string;
  [key: string]: unknown;
}

export interface AttachmentRecord {
  type: "attachment";
  ts: Timestamp;
  uuid?: string;
  attachment: GoalStatusAttachment | QueuedCommandAttachment | ForeignAttachment;
  isSidechain?: boolean;
}

export interface TurnCompletionRecord {
  type: "turn_completion";
  ts: Timestamp;
  durationMs: number;
}

/**
 * Worktree-state stamp: appended whenever the session's active worktree
 * changes (enter, exit, restore, failed restore). The latest stamp is the
 * resume-time source of truth for worktree restoration; `state: null` records
 * an explicit exit. The project-config slot is a secondary index of the same
 * state, kept for cross-session discovery (stranded-transcript match set).
 */
export interface WorktreeStateRecord {
  type: "worktree_state";
  ts: Timestamp;
  sessionId: string;
  state: Record<string, unknown> | null;
}

export interface ContentReplacementSessionRecord {
  type: "content_replacement";
  ts: Timestamp;
  kind: "tool-result";
  toolUseId: string;
  replacement: string;
  isSidechain?: boolean;
  parentToolCallId?: string | undefined;
  parentAgentId?: string | undefined;
  agentDepth?: number | undefined;
  agentId?: string | undefined;
}

export type SessionRecord =
  | SessionMetaRecord
  | UserMessageRecord
  | AssistantMessageRecord
  | ToolCallRecord
  | ToolResultRecord
  | HookEventRecord
  | UsageRecord
  | CompactionMarkRecord
  | InjectionQueuedRecord
  | AttachmentRecord
  | TurnCompletionRecord
  | ContentReplacementSessionRecord
  | WorktreeStateRecord;

export const KNOWN_TYPES: ReadonlySet<RecordType> = new Set([
  "session_meta",
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "hook_event",
  "usage",
  "compaction_mark",
  "injection_queued",
  "attachment",
  "turn_completion",
  "content_replacement",
  "worktree_state",
]);

export interface SessionStamp {
  sessionId: string;
  /** Always the project storage cwd (transcript identity), never the active worktree path. */
  cwd: string;
  version?: string;
  gitBranch?: string;
}

export interface OsCompactionSidecar {
  summaryRef: unknown;
  version?: number;
  trigger?: CompactionMarkRecord["trigger"];
  preservedSegment?: PreservedSegment;
  preservedMessages?: PreservedMessages;
  preTokens?: number;
  preservedImages?: ContentBlock[];
  error?: string;
  rapidRefillCount?: number;
  consecutiveFailures?: number;
}

export interface OsSidecar {
  provider?: string;
  model?: string;
  producedAccount?: string;
  thoughtTokens?: number;
  requestCount?: number;
  parentToolCallId?: string;
  parentAgentId?: string;
  agentDepth?: number;
  pastedImages?: UserMessagePastedImage[];
  imagePasteIds?: number[];
  attachments?: unknown[];
  queueId?: string;
  isRemote?: boolean;
  compaction?: OsCompactionSidecar;
  effort?: string;
  fastMode?: boolean;
  ultracode?: boolean;
  toolResultMeta?: ToolResultMeta;
  agentModel?: string;
}

export interface UpstreamMessageEnvelope {
  type?: string;
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  toolUseResult?: unknown;
  toolUseId?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  summary?: string;
  leafUuid?: string;
}

export function nowIso(): Timestamp {
  const d = new Date();
  return d.toISOString();
}

export function isChainParticipant(type: RecordType): boolean {
  return (
    type === "user_message" ||
    type === "assistant_message" ||
    type === "tool_call" ||
    type === "tool_result" ||
    type === "attachment" ||
    type === "compaction_mark"
  );
}

export function providerFromModelId(model: string): ProviderId | undefined {
  return /^claude-/.test(model) ? "anthropic" : undefined;
}
