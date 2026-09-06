import * as providers from "@/engine/providers/registry.ts";
import { streamWithRetry } from "@/engine/transport/retry.ts";
import type { ComposedHarness } from "@/harness/composer/injections.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const ONE_SHOT_COMPLETION_TIMEOUT_MS = 60_000;

export async function executeOneShotCompletion(
  requestContext: RequestContext,
  systemPrompt: string,
  userPrompt: string,
  maxTokens?: number,
  temperature?: number,
): Promise<string> {
  const provider = providers.get(requestContext.provider);
  const harness: ComposedHarness = {
    layers: [{ name: "one-shot-completion", body: systemPrompt }],
    combined: systemPrompt,
    systemBlocks: [{ text: systemPrompt }],
    userPrepend: [],
    midSystemPromotion: "off",
  };
  const request: Message = {
    role: "user",
    content: [{ type: "text", text: userPrompt }],
  };
  const composed = provider.composeMessages(harness, [request]);
  // The turn's signal may already be aborted by the time this background
  // completion runs — swap it for a standalone timeout so a stalled provider
  // can't hang title generation or llm.complete forever.
  const { abortSignal, ...oneShotCtxRest } = requestContext;
  const oneShotCtx: RequestContext = {
    ...oneShotCtxRest,
    abortSignal: AbortSignal.timeout(ONE_SHOT_COMPLETION_TIMEOUT_MS),
  };
  const originalBody = provider.translateRequest(oneShotCtx, composed, []);

  const body = { ...(originalBody as Record<string, unknown>) };
  body.max_tokens = maxTokens ?? 512;
  body.thinking = { type: "disabled" };
  body.temperature = temperature ?? 0.7;
  body.tools = [];

  let text = "";
  for await (const event of streamWithRetry(oneShotCtx, provider, body)) {
    if (event.kind === "text_delta") text += event.text;
    if (event.kind === "stream_reset") text = "";
    if (event.kind === "error" || event.kind === "quota_exhausted") break;
    if (event.kind === "message_stop") break;
  }
  return text;
}
