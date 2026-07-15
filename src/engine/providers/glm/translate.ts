import { parseModelId } from "@/engine/model/catalog.ts";
import { isVisionCapable, stripNonVisionImages } from "@/engine/model/facts/capabilities.ts";
import {
  buildKimiMessages,
  translateResponseKimi,
} from "@/engine/providers/_shared/anthropic-compat-wire.ts";
import { buildGlmEnvelope } from "@/engine/providers/glm/envelope.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export function translateRequestGlm(
  ctx: RequestContext,
  messages: Message[],
  tools: unknown[],
): unknown {
  const parsed = parseModelId(ctx.model);
  const wireInputMessages = isVisionCapable(ctx.provider, ctx.model)
    ? messages
    : stripNonVisionImages(messages);
  // composeGlmMessages already placed cache_control in the correct shape and
  // spots (consolidated system blocks, trailing user block) — this is a pure
  // wire-shape split, no cache re-derivation needed.
  const { system: wireSystem, out: wireMessages } = buildKimiMessages(
    wireInputMessages,
    ctx.provider,
  );
  return buildGlmEnvelope({
    ctx,
    modelBase: parsed.base,
    wireSystem,
    wireMessages,
    tools,
  });
}

export const translateResponseGlm = translateResponseKimi;
