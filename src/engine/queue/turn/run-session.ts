import type { TurnObserver } from "@/engine/queue/turn/observer.ts";
import type { AgentEvent } from "@/kernel/std/types/events.ts";

export async function runSessionTurn(
  source: AsyncIterable<AgentEvent>,
  observer: TurnObserver,
): Promise<void> {
  for await (const event of source) {
    await observer.onAny?.(event);
    await dispatchTurnEvent(event, observer);
  }
}

async function dispatchTurnEvent(event: AgentEvent, observer: TurnObserver): Promise<void> {
  switch (event.kind) {
    case "message_start":
      return observer.message_start?.(event);
    case "usage":
      return observer.usage?.(event);
    case "usage_limits":
      return observer.usage_limits?.(event);
    case "text_delta":
      return observer.text_delta?.(event);
    case "thinking_delta":
      return observer.thinking_delta?.(event);
    case "thinking_signature":
      return observer.thinking_signature?.(event);
    case "tool_call_start":
      return observer.tool_call_start?.(event);
    case "tool_call_input_delta":
      return observer.tool_call_input_delta?.(event);
    case "tool_call_complete":
      return observer.tool_call_complete?.(event);
    case "message_stop":
      return observer.message_stop?.(event);
    case "retry_status":
      return observer.retry_status?.(event);
    case "stream_reset":
      return observer.stream_reset?.(event);
    case "error":
      return observer.error?.(event);
    case "quota_exhausted":
      return observer.quota_exhausted?.(event);
    case "turn_start":
      return observer.turn_start?.(event);
    case "tool_dispatch_start":
      return observer.tool_dispatch_start?.(event);
    case "tool_dispatch_complete":
      return observer.tool_dispatch_complete?.(event);
    case "tool_dispatch_backgrounded":
      return observer.tool_dispatch_backgrounded?.(event);
    case "tool_dispatch_progress":
      return observer.tool_dispatch_progress?.(event);
    case "queued_input_drained":
      return observer.queued_input_drained?.(event);
    case "compact_start":
      return observer.compact_start?.(event);
    case "compact_done":
      return observer.compact_done?.(event);
    case "micro_compact":
      return observer.micro_compact?.(event);
    case "turn_end":
      return observer.turn_end?.(event);
    case "silent_turn_end_recovery":
      return observer.silent_turn_end_recovery?.(event);
    case "goal_eval_start":
      return observer.goal_eval_start?.(event);
    case "goal_met":
      return observer.goal_met?.(event);
    case "goal_not_met":
      return observer.goal_not_met?.(event);
    case "goal_continue":
      return observer.goal_continue?.(event);
    case "goal_paused_bg":
      return observer.goal_paused_bg?.(event);
    case "fork_start":
      return observer.fork_start?.(event);
    case "fork_text_delta":
      return observer.fork_text_delta?.(event);
    case "fork_tool_input_delta":
      return observer.fork_tool_input_delta?.(event);
    case "fork_tool_dispatch_start":
      return observer.fork_tool_dispatch_start?.(event);
    case "fork_tool_dispatch_complete":
      return observer.fork_tool_dispatch_complete?.(event);
    case "fork_usage":
      return observer.fork_usage?.(event);
    case "fork_retry_status":
      return observer.fork_retry_status?.(event);
    case "fork_stream_reset":
      return observer.fork_stream_reset?.(event);
    case "fork_complete":
      return observer.fork_complete?.(event);
    case "fork_quota_exhausted":
      return observer.fork_quota_exhausted?.(event);
    case "sidechain_persist_error":
      return observer.sidechain_persist_error?.(event);
    default:
      return assertExhaustive(event);
  }
}

function assertExhaustive(event: never): void {
  void event;
}
