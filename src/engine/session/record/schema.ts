import type { CompactionSummaryRef } from "@/engine/session/compact/summary-spill.ts";
import { isTruthyCompactionSummaryRef } from "@/engine/session/compact/summary-spill.ts";
import type { McpCallIdentity } from "@/kernel/mcp/protocol/tool-label.ts";
import type { ContentBlock, ToolResultMeta } from "@/kernel/std/types/message.ts";
import {
  isProviderId,
  type ProviderId,
  type ProviderModelRoute,
} from "@/kernel/std/types/provider-ids.ts";

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
  | "injection_dequeued"
  | "attachment"
  | "turn_completion"
  | "content_replacement"
  | "worktree_state";

export interface SessionMetaRecord {
  type: "session_meta";
  ts: Timestamp;
  cwd: string;
  /** Atomic provider+model when both are known. Prefer over independent fields. */
  route?: ProviderModelRoute;
  provider?: string;
  model?: string;
  effort?: string;
  fastMode?: boolean;
  ultracode?: boolean;
  orchestrationMode?: string;
  remoteEnabled?: boolean;
}

export interface UserMessagePastedImage {
  id: number;
  data: string;
  mediaType: string;
  /** Where the paste was written in the image cache, so a replayed chip still opens. */
  localPath?: string;
}

export interface UserMessageRecord {
  type: "user_message";
  ts: Timestamp;
  uuid?: string;
  content: string;
  /** Atomic provider+model when both are known. Prefer over independent fields. */
  route?: ProviderModelRoute;
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
  /** Atomic provider+model when both are known. Prefer over independent fields. */
  route?: ProviderModelRoute;
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
  /** How the serving MCP server named itself and this tool. Absent off MCP. */
  mcpIdentity?: McpCallIdentity;
  /** Atomic provider+model when both are known. Prefer over independent fields. */
  route?: ProviderModelRoute;
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
  /** Atomic agent identity when known. Prefer this over bare agentModel. */
  agentRoute?: ProviderModelRoute;
  /** @deprecated Prefer agentRoute. Still written for older readers. */
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
  /**
   * Set on a record standing for the summed spend of history a resume did not
   * materialize. It counts toward spend totals but is never a context snapshot:
   * a sum says nothing about how full the window was at any single request.
   */
  rollup?: boolean | undefined;
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

export interface CompactKeepList {
  uuids: string[];
  anchorUuid: string;
}

/**
 * Wire-only pointer to a preserved image already stored in full on an earlier
 * compaction mark. In-memory records always carry the resolved blocks.
 */
export interface PreservedImageRef {
  type: "image_ref";
  markUuid: string;
  index: number;
}

export interface CompactionMarkRecord {
  type: "compaction_mark";
  ts: Timestamp;
  uuid?: string;
  summary_ref: CompactionSummaryRef;
  /** Atomic provider+model when both are known. Prefer over independent fields. */
  route?: ProviderModelRoute;
  provider?: string;
  model?: string;
  version?: number;
  leafUuid?: string;
  preservedSegment?: PreservedSegment;
  preservedMessages?: CompactKeepList;
  preTokens?: number;
  trigger?: "auto" | "manual" | "rapid_refill_trip" | "circuit_breaker_trip" | "auto_failure";
  preservedImages?: (ContentBlock | PreservedImageRef)[];
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

// Records that a queued user input left the queue WITHOUT being delivered to
// the model (cancel restores queue text to the prompt; the user may edit or
// discard it). Replay treats it like a delivery: it consumes one earlier
// queued copy of the same text so resume/rewind never re-deliver input the
// user took back.
export interface InjectionDequeuedRecord {
  type: "injection_dequeued";
  ts: Timestamp;
  text: string;
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
  met: boolean;
  sentinel: true;
  cleared?: boolean;
  failed?: boolean;
  reason?: string;
  iteration?: number;
}

export function goalStatusAttachment(
  condition: string,
  status: Omit<GoalStatusAttachment, "type" | "condition" | "sentinel">,
): GoalStatusAttachment {
  const { met, ...details } = status;
  return {
    type: "goal_status",
    met,
    sentinel: true,
    condition,
    ...details,
  };
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

export interface ToolOutputArchiveSessionRecord {
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
  | InjectionDequeuedRecord
  | AttachmentRecord
  | TurnCompletionRecord
  | ToolOutputArchiveSessionRecord
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
  "injection_dequeued",
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
  preservedMessages?: CompactKeepList;
  preTokens?: number;
  preservedImages?: (ContentBlock | PreservedImageRef)[];
  error?: string;
  rapidRefillCount?: number;
  consecutiveFailures?: number;
}

export interface OsSidecar {
  /** Atomic provider+model when both are known. Prefer over independent fields. */
  route?: ProviderModelRoute;
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
  remoteEnabled?: boolean;
  toolResultMeta?: ToolResultMeta;
  mcpIdentity?: McpCallIdentity;
  /** Atomic agent identity (new). Prefer over bare agentModel. */
  agentRoute?: ProviderModelRoute;
  /** Legacy bare model; still read when agentRoute is absent. */
  agentModel?: string;
  /** Legacy companion to agentModel when the full route was not written. */
  agentProvider?: string;
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

export function isTranscriptLinked(type: RecordType): boolean {
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

/**
 * Normalize independent provider/model (and optional route) into an atomic route.
 * - Prefer an explicit valid `route`.
 * - When loose provider+model both exist, form a route if provider is a ProviderId.
 * - When route and loose fields disagree, keep the route and drop the loose halves
 *   that conflict (validation = route wins).
 * - Legacy single-half records stay as independent fields with no route.
 */
export function normalizeRecordRoute(fields: {
  route?: ProviderModelRoute | { provider?: string; model?: string } | undefined;
  provider?: string | undefined;
  model?: string | undefined;
}): {
  route?: ProviderModelRoute;
  provider?: string;
  model?: string;
} {
  const explicit = coerceRoute(fields.route);
  if (explicit) {
    const out: { route: ProviderModelRoute; provider: string; model: string } = {
      route: explicit,
      provider: explicit.provider,
      model: explicit.model,
    };
    return out;
  }
  const provider = typeof fields.provider === "string" ? fields.provider : undefined;
  const model = typeof fields.model === "string" ? fields.model : undefined;
  if (provider !== undefined && model !== undefined && isProviderId(provider)) {
    const route = { provider, model };
    return { route, provider: route.provider, model: route.model };
  }
  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

function coerceRoute(
  value: ProviderModelRoute | { provider?: string; model?: string } | undefined,
): ProviderModelRoute | undefined {
  if (!value) return undefined;
  if (typeof value.provider !== "string" || !isProviderId(value.provider)) return undefined;
  if (typeof value.model !== "string" || value.model.length === 0) return undefined;
  return { provider: value.provider, model: value.model };
}
