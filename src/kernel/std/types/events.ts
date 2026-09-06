import type { EffortLevel } from "@/kernel/std/types/effort.ts";
import type { ErrorMeta } from "@/kernel/std/types/error-meta.ts";
import type { ContentBlock, ToolResultMeta } from "@/kernel/std/types/message.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";

export type ToolProgress =
  | { kind: "search_count"; filesScanned: number; matched: number; preview?: string }
  | { kind: "backgrounded"; taskId: string; reason: string }
  | { kind: "queued"; reason: string }
  | { kind: "text"; text: string };

export type ToolProgressSink = (progress: ToolProgress) => void;

export type ProviderEvent =
  | {
      kind: "message_start";
      id?: string;
      requestId?: string;
      provider?: ProviderId;
      model?: string;
    }
  | {
      kind: "usage";
      inputTokens?: number;
      outputTokens?: number;
      thoughtTokens?: number;
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
    }
  | { kind: "usage_limits"; provider: ProviderId; usage: unknown }
  | { kind: "text_delta"; text: string }
  | { kind: "thinking_delta"; text: string }
  | { kind: "thinking_signature"; signature: string }
  | { kind: "tool_call_start"; id: string; name: string }
  | { kind: "tool_call_input_delta"; id: string; partial: string }
  | {
      kind: "tool_call_complete";
      id: string;
      name: string;
      input: unknown;
      serverHandled?: boolean;
    }
  | { kind: "message_stop"; stop_reason: string; refusal?: string }
  | {
      kind: "retry_status";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: string;
      status?: number;
      message?: string;
    }
  | { kind: "stream_reset"; reason: string; attempt: number }
  | { kind: "error"; error: string; meta?: ErrorMeta }
  | {
      kind: "quota_exhausted";
      provider: string;
      model: string;
      resetEpochMs: number | null;
      message: string;
      meta?: ErrorMeta;
      // "quota" (default when absent) = plan/credit exhaustion — quota UI,
      // turn stops. "rate_limited" = soft 429/529 retry exhaustion — contained
      // error surface, never the plan-quota UI or a whole-turn cancel.
      reason?: "quota" | "rate_limited";
    };

export type ForkEvent =
  | {
      kind: "fork_start";
      forkId: string;
      name: string;
      provider: ProviderId;
      model: string;
      effort?: EffortLevel;
      description?: string;
      parentToolCallId?: string;
    }
  | { kind: "fork_text_delta"; forkId: string; text: string; parentToolCallId?: string }
  | {
      kind: "fork_tool_input_delta";
      forkId: string;
      toolCallId: string;
      toolName: string;
      partial: string;
      parentToolCallId?: string;
    }
  | {
      kind: "fork_tool_dispatch_start";
      forkId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
      parentToolCallId?: string;
    }
  | {
      kind: "fork_tool_dispatch_complete";
      forkId: string;
      toolCallId: string;
      toolName: string;
      content: string;
      displayContent?: string;
      isError: boolean;
      parentToolCallId?: string;
    }
  | {
      kind: "fork_usage";
      forkId: string;
      // The fork's own provider/model — usage is attributed to these, not the
      // parent's ambient provider/model (a subagent may run a different model).
      provider?: ProviderId;
      model?: string;
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
      thoughtTokens?: number;
      parentToolCallId?: string;
      isSnapshot?: boolean;
    }
  | {
      kind: "fork_retry_status";
      forkId: string;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: string;
      parentToolCallId?: string;
    }
  | {
      kind: "fork_stream_reset";
      forkId: string;
      // Exact char count of fork_text_delta already emitted by the voided
      // attempt — downstream accumulators trim this many chars off their tail.
      discardedChars: number;
      parentToolCallId?: string;
    }
  | {
      kind: "fork_complete";
      forkId: string;
      output: string;
      isError: boolean;
      parentToolCallId?: string;
    }
  | {
      kind: "fork_quota_exhausted";
      forkId: string;
      provider: string;
      model: string;
      resetEpochMs: number | null;
      message: string;
      reason?: "quota" | "rate_limited";
      parentToolCallId?: string;
    }
  | {
      kind: "sidechain_persist_error";
      agentId: string;
      parentToolCallId?: string;
      error: string;
    };

export type ForkEventSink = (event: ForkEvent) => void;

export interface DrainedQueuedMessage {
  text: string;
  blocks: ContentBlock[];
  queueId?: string;
  pastedImages?: { id: number; data: string; mediaType: string; localPath?: string }[];
  remotePayload?: unknown;
}

export interface BackgroundController {
  signal: () => void;
  isBackgrounded: () => boolean;
  abort?: () => void;
  taskId?: string;
  signaled?: Promise<void>;
}

export type AgentEvent =
  | ProviderEvent
  | { kind: "turn_start"; turn: number }
  | { kind: "tool_dispatch_start"; id: string; name: string; input: unknown }
  | {
      kind: "tool_dispatch_complete";
      id: string;
      name: string;
      content: string;
      // Original result text when `content` was replaced by a persisted-output
      // wrapper — display renders this; wire and session records keep the wrapper.
      displayContent?: string;
      isError: boolean;
      meta?: ToolResultMeta;
    }
  | { kind: "tool_dispatch_backgrounded"; id: string; name: string }
  | { kind: "tool_dispatch_progress"; id: string; name: string; progress: ToolProgress }
  | { kind: "queued_input_drained"; messages: DrainedQueuedMessage[] }
  | { kind: "compact_start"; preTokens: number; threshold: number; window: number }
  | {
      kind: "compact_done";
      mode: "summary" | "failed";
      droppedMessages: number;
      truncatedMessages: number;
      preTokens: number;
      durationMs: number;
      summary?: string;
      error?: string;
      restoredFiles?: { path: string; numLines: number }[];
    }
  | {
      kind: "micro_compact";
      cleared: number;
      kept: number;
      tokensSavedEstimate: number;
      preTokens: number;
      threshold: number;
      clearedToolUseIds?: string[];
    }
  | { kind: "turn_end"; turn: number; stopReason: string }
  | { kind: "silent_turn_end_recovery"; turn: number; iteration: number }
  | { kind: "goal_eval_start"; condition: string; iteration: number }
  | { kind: "goal_met"; condition: string; iteration: number }
  | { kind: "goal_not_met"; condition: string; iteration: number; reason: string }
  | { kind: "goal_continue"; condition: string; iteration: number }
  | {
      kind: "goal_paused_bg";
      condition: string;
      iteration: number;
      runningBackgroundTasks: number;
    }
  | ForkEvent;

export type CodexSubAgentLabel =
  | "review"
  | "compact"
  | "memory_consolidation"
  | "collab_spawn"
  | string;
