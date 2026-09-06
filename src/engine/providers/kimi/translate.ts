import {
  defaultEffortForModel,
  effortLevelsForModel,
  parseModelId,
} from "@/engine/model/catalog.ts";
import {
  buildCompatMessages,
  compatResponseTranslator,
  tagLastToolCache,
  userIdMetadata,
} from "@/engine/providers/_shared/anthropic-compat-wire.ts";
import { usageFromAnthropicPromptTotal } from "@/engine/providers/_shared/usage.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

// The coding endpoint counts the cached prefix inside `input_tokens`: a hit
// reports the whole prompt there and names the same tokens again under
// cache_read, so the fresh share is the remainder.
export const translateResponseKimi = compatResponseTranslator({
  usage: usageFromAnthropicPromptTotal,
  endpointLabel: "kimi/coding/messages",
});

export function translateRequestKimi(
  ctx: RequestContext,
  messages: Message[],
  tools: unknown[],
): unknown {
  const parsed = parseModelId(ctx.model);
  const { system, out } = buildCompatMessages(messages, ctx.provider);

  const body: Record<string, unknown> = {
    model: parsed.base,
    messages: out,
    max_tokens: 32_000,
    stream: true,
    metadata: { user_id: userIdMetadata(ctx.sessionId) },
  };
  if (system && system.length > 0) body.system = system;
  if (tools && tools.length > 0) body.tools = tagLastToolCache(tools);
  if (ctx.disableThinking !== true) {
    const supportedEfforts = effortLevelsForModel({ provider: ctx.provider, model: parsed.base });
    const effort =
      ctx.effort ?? defaultEffortForModel({ provider: ctx.provider, model: parsed.base });
    body.thinking = {
      type: "enabled",
      ...(effort !== null && supportedEfforts.includes(effort) ? { effort } : {}),
    };
  }
  return body;
}
