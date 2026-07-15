import { providerEndpoint } from "@/devtools/config.ts";
import { parseModelId } from "@/engine/model/catalog.ts";
import {
  fingerprint as anthropicFingerprint,
  anthropicWireModelId,
} from "@/engine/providers/anthropic/_infra/fingerprint.ts";
import { authorizationHeader as anthropicAuthorizationHeader } from "@/engine/providers/anthropic/auth.ts";
import { buildAnthropicMessages } from "@/engine/providers/anthropic/translate.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export const ANTHROPIC_COUNT_TOKENS_URL = providerEndpoint(
  "anthropic",
  "countTokens",
  "https://api.anthropic.com/v1/messages/count_tokens?beta=true",
);
export const COUNT_TOKENS_BETA = "token-counting-2024-11-01";

export interface CountTokensResult {
  input_tokens: number;
}

export function buildCountTokensRequest(
  ctx: RequestContext,
  messages: Message[],
  tools: unknown[],
): Record<string, unknown> {
  const parsed = parseModelId(ctx.model);
  const { system, out } = buildAnthropicMessages(messages, ctx);
  const body: Record<string, unknown> = {
    model: anthropicWireModelId(parsed.base, ctx.agentic !== false && !ctx.parentThreadId),
    messages: out,
  };
  if (system && system.length > 0) body.system = system;
  if (tools && tools.length > 0) body.tools = tools;
  return body;
}

export function buildCountTokensHeaders(ctx: RequestContext, auth: string): Record<string, string> {
  const fp = anthropicFingerprint(ctx);
  const existingBeta = fp.extraHeaders["anthropic-beta"] ?? "";
  const mergedBeta = existingBeta ? `${existingBeta},${COUNT_TOKENS_BETA}` : COUNT_TOKENS_BETA;
  return {
    Authorization: auth,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": fp.userAgent,
    ...fp.extraHeaders,
    "anthropic-beta": mergedBeta,
  };
}

export async function countTokensAnthropic(
  ctx: RequestContext,
  messages: Message[],
  tools: unknown[] = [],
): Promise<CountTokensResult> {
  const auth = await anthropicAuthorizationHeader();
  const headers = buildCountTokensHeaders(ctx, auth);
  const body = buildCountTokensRequest(ctx, messages, tools);

  const resp = await fetch(ANTHROPIC_COUNT_TOKENS_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} from /v1/messages/count_tokens: ${text.slice(0, 300)}`);
  }

  const parsed = (await resp.json()) as { input_tokens?: number };
  if (typeof parsed.input_tokens !== "number") {
    throw new Error(`invalid count_tokens response shape: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  return { input_tokens: parsed.input_tokens };
}
