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
  const brokerState = deps.broker.read();
  const account = accountFingerprint(brokerState.provider);
  const blocks: ContentBlock[] = [];
  if (thinking.length > 0 || thinkingSignature.length > 0) {
    const block: Extract<ContentBlock, { type: "thinking" }> = {
      type: "thinking",
      text: thinking,
      producedBy: brokerState.provider,
      producedModel: brokerState.model,
    };
    if (thinkingSignature) block.signature = thinkingSignature;
    if (account) block.producedAccount = account;
    blocks.push(block);
  }
  if (text.trim().length > 0) blocks.push({ type: "text", text });
  for (const c of toolCalls) {
    blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
  }
  if (blocks.length === 0) return;
  const id = assistantId ?? `asst_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const msg: Message = {
    role: "assistant",
    id,
    content: blocks,
    producedBy: brokerState.provider,
    producedModel: brokerState.model,
    ts: Date.now(),
  };
  if (account) msg.producedAccount = account;
  if (usage) msg.usage = usage;
  if (requestId) msg.requestId = requestId;
  deps.session.messages.push(msg);
}
