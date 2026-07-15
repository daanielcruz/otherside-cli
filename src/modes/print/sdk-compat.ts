import type { AgentEvent, ProviderEvent } from "@/kernel/std/types/events.ts";
import type { PrintOutputFormat } from "./types.ts";

// The SDK-compat headless surface names the agent-spawn tool `Task`; every other
// tool keeps its name. Applied only to the emitted `tools` list, not the runtime.
export function sdkToolName(name: string): string {
  return name === "Agent" ? "Task" : name;
}

export function shouldEmitProviderEvents(outputFormat: PrintOutputFormat): boolean {
  return (
    outputFormat === "stream-json" && process.env.OTHERSIDE_CLI_INCLUDE_PARTIAL_MESSAGES === "1"
  );
}

export function isProviderEvent(event: AgentEvent): event is ProviderEvent {
  switch (event.kind) {
    case "message_start":
    case "usage":
    case "usage_limits":
    case "text_delta":
    case "thinking_delta":
    case "thinking_signature":
    case "tool_call_start":
    case "tool_call_input_delta":
    case "tool_call_complete":
    case "message_stop":
    case "retry_status":
    case "stream_reset":
    case "error":
    case "quota_exhausted":
      return true;
    default:
      return false;
  }
}
