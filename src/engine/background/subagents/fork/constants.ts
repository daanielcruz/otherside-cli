import {
  MAX_CONSECUTIVE_RAPID_REFILLS,
  RAPID_REFILL_TURN_THRESHOLD,
} from "@/engine/session/compact/index.ts";

export const MAX_FORK_COMPACT_FAILURES = 3;
export const FORK_RAPID_REFILL_TURN_THRESHOLD = RAPID_REFILL_TURN_THRESHOLD;
export const MAX_FORK_RAPID_REFILLS = MAX_CONSECUTIVE_RAPID_REFILLS;
export const MAX_DEGENERATE_TOOL_CALLS = 3;
export const MAX_FORK_STALL_RETRIES = 2;
export const WORKFLOW_DEFAULT_STALL_MS = 180000;
export const WORKFLOW_STALL_ABORT_REASON = "stalled";
export const STRUCTURED_OUTPUT_RETRIES_EXCEEDED = "error_max_structured_output_retries";
export const DEGENERATE_TOOL_LOOP_MESSAGE =
  "Subagent aborted: the model repeatedly emitted invalid or identical failing tool calls without making progress.";
export const FORK_PROMPT_TOO_LONG_MESSAGE = "Prompt is too long";
