import { accountFingerprint } from "@/engine/providers/_shared/account-identity.ts";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";
import type { TurnAttempt } from "./attempt.ts";
import type { AgentDeps } from "./types.ts";

/**
 * Turns what one attempt produced into the assistant message the next request
 * will carry. Takes the attempt whole: the nine values it reads only ever travel
 * together, and naming them one by one at the call site invites a mix-up between
 * the several that are strings.
 */
export function commitAssistantMessage(deps: AgentDeps, attempt: TurnAttempt): void {
  const { text, toolCalls, thinking, thinkingSignature } = attempt;
  // Stamp provenance with the route that PRODUCED this turn's bytes, not the
  // live broker: a mid-turn provider switch must not relabel foreign reasoning
  // as the switched-to provider, or its signature replays onto the new wire.
  const brokerState = deps.broker.read();
  const provider = attempt.producedProvider ?? brokerState.provider;
  const model = attempt.producedModel ?? brokerState.model;
  const account = accountFingerprint(provider);
  const blocks: ContentBlock[] = [];
  if (thinking.length > 0 || thinkingSignature.length > 0) {
    const block: Extract<ContentBlock, { type: "thinking" }> = {
      type: "thinking",
      text: thinking,
      producedBy: provider,
      producedModel: model,
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
  const id = attempt.messageId ?? `asst_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const msg: Message = {
    role: "assistant",
    id,
    content: blocks,
    producedBy: provider,
    producedModel: model,
    ts: Date.now(),
  };
  if (account) msg.producedAccount = account;
  if (attempt.usage) msg.usage = attempt.usage;
  if (attempt.requestId) msg.requestId = attempt.requestId;
  deps.session.messages.push(msg);
}
