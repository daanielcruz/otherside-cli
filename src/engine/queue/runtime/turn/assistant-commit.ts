import { accountFingerprint } from "@/engine/providers/_shared/account-identity.ts";
import type { ContentBlock, Message, ToolCall } from "@/kernel/std/types/message.ts";
import type { AgentDeps } from "./types.ts";

export function commitAssistantMessage(
  deps: AgentDeps,
  text: string,
  toolCalls: ToolCall[],
  thinking = "",
  thinkingSignature = "",
  assistantId?: string,
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  },
  requestId?: string,
): void {
  const blocks: ContentBlock[] = [];
  if (thinking.length > 0 || thinkingSignature.length > 0) {
    const block: { type: "thinking"; text: string; signature?: string } = {
      type: "thinking",
      text: thinking,
    };
    if (thinkingSignature) block.signature = thinkingSignature;
    blocks.push(block);
  }
  if (text.trim().length > 0) blocks.push({ type: "text", text });
  for (const c of toolCalls) {
    blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
  }
  if (blocks.length === 0) return;
  const id = assistantId ?? `asst_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const brokerState = deps.broker.read();
  const msg: Message = {
    role: "assistant",
    id,
    content: blocks,
    producedBy: brokerState.provider,
    producedModel: brokerState.model,
    ts: Date.now(),
  };
  const account = accountFingerprint(brokerState.provider);
  if (account) msg.producedAccount = account;
  if (usage) msg.usage = usage;
  if (requestId) msg.requestId = requestId;
  deps.session.messages.push(msg);
}
