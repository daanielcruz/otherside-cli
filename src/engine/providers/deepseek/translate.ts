import { stripNonVisionImages } from "@/engine/model/facts/capabilities.ts";
import {
  translateRequestAnthropic,
  translateResponseAnthropic,
} from "@/engine/providers/anthropic/translate.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export function translateRequestDeepseek(
  ctx: RequestContext,
  messages: Message[],
  tools: unknown[],
): unknown {
  const stripped = stripNonVisionImages(messages);
  const body = translateRequestAnthropic(ctx, stripped, tools) as Record<string, unknown>;
  const thinkingDisabled = ctx.disableThinking === true;
  if (thinkingDisabled) {
    body.thinking = { type: "disabled" };
    const output = body.output_config;
    if (output && typeof output === "object" && !Array.isArray(output)) {
      delete (output as Record<string, unknown>).effort;
    }
  }
  return body;
}

export const translateResponseDeepseek = translateResponseAnthropic;
