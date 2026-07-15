import type { EmitItemInput } from "@/engine/queue/priority.ts";
import type { ContentBlock, ToolCall } from "@/kernel/std/types/message.ts";
import type { AgentDeps } from "./turn/types.ts";

export interface OrphanSynthInput {
  readonly toolCalls: readonly ToolCall[];
  readonly seen: ReadonlySet<string>;
  readonly content?: string;
}

const DEFAULT_CONTENT = "Interrupted by user";

export function drainOrphanInterrupts(input: OrphanSynthInput): EmitItemInput[] {
  const content = input.content ?? DEFAULT_CONTENT;
  const out: EmitItemInput[] = [];
  for (const call of input.toolCalls) {
    if (input.seen.has(call.id)) continue;
    out.push({
      class: "interrupt_bash",
      target: "llm_request",
      payload: { kind: "tool_result_interrupt", toolUseId: call.id, content },
      replayKey: `orphan:${call.id}`,
      sticky: true,
    });
  }
  return out;
}

export function flushOrphanToolUses(deps: AgentDeps, toolCalls: ToolCall[], reason: string): void {
  if (toolCalls.length === 0) return;
  const blocks: ContentBlock[] = toolCalls.map((c) => ({
    type: "tool_result" as const,
    tool_use_id: c.id,
    content: reason,
    is_error: true,
  }));
  deps.session.messages.push({ role: "user", content: blocks });
}
