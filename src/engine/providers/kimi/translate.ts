import {
  defaultEffortForModel,
  effortLevelsForModel,
  parseModelId,
} from "@/engine/model/catalog.ts";
import {
  buildKimiMessages,
  tagLastToolCache,
  userIdMetadata,
} from "@/engine/providers/_shared/anthropic-compat-wire.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export { translateResponseKimi } from "@/engine/providers/_shared/anthropic-compat-wire.ts";

export function translateRequestKimi(
  ctx: RequestContext,
  messages: Message[],
  tools: unknown[],
): unknown {
  const parsed = parseModelId(ctx.model);
  const { system, out } = buildKimiMessages(messages, ctx.provider);

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
    const supportedEfforts = effortLevelsForModel(parsed.base, ctx.provider);
    const effort = ctx.effort ?? defaultEffortForModel(parsed.base, ctx.provider);
    body.thinking = {
      type: "enabled",
      ...(effort !== null && supportedEfforts.includes(effort) ? { effort } : {}),
    };
  }
  return body;
}
