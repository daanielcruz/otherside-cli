import { currentApiKey } from "@/engine/providers/kimi/auth.ts";
import { fingerprint } from "@/engine/providers/kimi/fingerprint.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import type { WebSearchInput, WebSearchPayload } from "./common.ts";

const DEFAULT_URL = "https://api.kimi.com/coding/v1/chat/completions";
const DEFAULT_MODEL = "kimi-k2-turbo-preview";
const MAX_ROUNDTRIPS = 4;

export async function searchKimi(
  input: WebSearchInput,
  ctx: RequestContext,
): Promise<WebSearchPayload> {
  const started = Date.now();
  const apiKey = await currentApiKey();
  const url = process.env.OTHERSIDE_KIMI_OPENAI_URL?.trim() || DEFAULT_URL;
  const model = process.env.OTHERSIDE_KIMI_SEARCH_MODEL?.trim() || DEFAULT_MODEL;
  const fp = fingerprint(ctx);
  const messages: Record<string, unknown>[] = [
    {
      role: "system",
      content:
        "You are an assistant for performing a web search. Use the $web_search tool to look up current information and return findings with source URLs.",
    },
    { role: "user", content: `Perform a web search for: ${input.query}` },
  ];
  const tools = [{ type: "builtin_function", function: { name: "$web_search" } }];
  for (let i = 0; i < MAX_ROUNDTRIPS; i += 1) {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": fp.userAgent,
        ...fp.extraHeaders,
      },
      body: JSON.stringify({ model, messages, tools, stream: false }),
    });
    const bodyText = await resp.text().catch(() => "");
    if (!resp.ok) {
      throw new Error(
        `WebSearch (kimi) returned HTTP ${resp.status}: ${truncateEllipsis(bodyText, 500)}`,
      );
    }
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
    const first = choices[0] as Record<string, unknown> | undefined;
    const msg = first?.message as Record<string, unknown> | undefined;
    if (!msg) throw new Error("WebSearch (kimi) response missing choices[0].message");
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (toolCalls.length === 0) {
      const content = typeof msg.content === "string" ? msg.content : "";
      return {
        query: input.query,
        provider: ctx.provider,
        results: [content || `No Kimi search result content for query: ${input.query}`],
        durationSeconds: (Date.now() - started) / 1000,
      };
    }
    messages.push({ ...msg, reasoning_content: msg.reasoning_content ?? "" });
    for (const call of toolCalls) {
      if (!call || typeof call !== "object") continue;
      const c = call as Record<string, unknown>;
      const callId = typeof c.id === "string" ? c.id : "";
      const fn = c.function as Record<string, unknown> | undefined;
      const name = typeof fn?.name === "string" ? fn.name : "";
      if (name !== "$web_search") {
        throw new Error(`WebSearch (kimi) emitted unexpected tool_call \`${name}\``);
      }
      messages.push({
        role: "tool",
        tool_call_id: callId,
        name: "$web_search",
        content: typeof fn?.arguments === "string" ? fn.arguments : "",
      });
    }
  }
  throw new Error(`WebSearch (kimi) exceeded ${MAX_ROUNDTRIPS} round-trips`);
}
