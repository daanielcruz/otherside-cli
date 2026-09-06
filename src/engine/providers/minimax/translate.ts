import { parseModelId } from "@/engine/model/catalog.ts";
import {
  buildCompatMessages,
  compatResponseTranslator,
  tagLastToolCache,
  userIdMetadata,
} from "@/engine/providers/_shared/anthropic-compat-wire.ts";
import { usageFromAnthropic } from "@/engine/providers/_shared/usage.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const MINIMAX_M3_MAX_OUTPUT_TOKENS = 512_000;
const MINIMAX_DEFAULT_MAX_OUTPUT_TOKENS = 131_072;

function minimaxMaxOutputTokens(modelBase: string): number {
  if (modelBase === "minimax-m3") return MINIMAX_M3_MAX_OUTPUT_TOKENS;
  return MINIMAX_DEFAULT_MAX_OUTPUT_TOKENS;
}

export function translateRequestMinimax(
  ctx: RequestContext,
  messages: Message[],
  tools: unknown[],
): unknown {
  const parsed = parseModelId(ctx.model);
  const { system, out } = buildCompatMessages(messages, ctx.provider);

  const body: Record<string, unknown> = {
    model: parsed.base,
    messages: out,
    max_tokens: minimaxMaxOutputTokens(parsed.base),
    stream: true,
    metadata: { user_id: userIdMetadata(ctx.sessionId) },
  };
  if (system && system.length > 0) body.system = system;
  if (tools && tools.length > 0) body.tools = tagLastToolCache(tools);
  return body;
}

// Disjoint prompt counters, as Anthropic's own API reports them: requests that
// read more from cache than they send fresh show cache_read is not a subset of
// input_tokens here.
export const translateResponseMinimax = compatResponseTranslator({
  usage: usageFromAnthropic,
  endpointLabel: "minimax/anthropic/messages",
});
