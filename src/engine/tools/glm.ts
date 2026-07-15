import { currentGlmChatCredential } from "@/engine/providers/glm/auth.ts";
import {
  API_MESSAGES_URL,
  authHeader,
  fingerprint,
  ZCODE_BETA_WEB_SEARCH,
} from "@/engine/providers/glm/fingerprint.ts";
import { parseSse } from "@/kernel/std/stream/sse.ts";
import { truncateEllipsis } from "@/kernel/std/text/text.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  bodyChunks,
  dedupeByUrl,
  filterResults,
  type WebSearchHit,
  type WebSearchInput,
  type WebSearchPayload,
} from "./common.ts";

const WEB_SEARCH_MAX_TOKENS = 4096;
const WEB_SEARCH_MAX_USES = 8;

export async function searchGlm(
  input: WebSearchInput,
  ctx: RequestContext,
): Promise<WebSearchPayload> {
  const started = Date.now();
  const chatCredential = await currentGlmChatCredential();
  const fp = fingerprint(ctx, ZCODE_BETA_WEB_SEARCH);
  const response = await fetch(API_MESSAGES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": fp.userAgent,
      ...fp.extraHeaders,
      ...authHeader(chatCredential),
    },
    ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
    body: JSON.stringify(buildGlmWebSearchBody(input.query)),
  });
  const result = await readGlmWebSearch(response);
  const filtered = filterResults(result.hits, input.allowedDomains, input.blockedDomains).slice(
    0,
    WEB_SEARCH_MAX_USES,
  );
  const results: WebSearchPayload["results"] = [];
  if (result.text.trim().length > 0) results.push(result.text.trim());
  results.push(...filtered);
  if (results.length === 0)
    results.push(`No Z.AI web_search results found for query: ${input.query}`);
  return {
    query: input.query,
    provider: ctx.provider,
    results,
    durationSeconds: (Date.now() - started) / 1000,
  };
}

export function buildGlmWebSearchBody(query: string): Record<string, unknown> {
  return {
    model: "GLM-5.2",
    max_tokens: WEB_SEARCH_MAX_TOKENS,
    system: [
      {
        type: "text",
        text: "You are an assistant for performing a web search tool use.",
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Perform a web search for the query: ${query}`,
          },
        ],
      },
    ],
    tools: [
      {
        type: "web_search_20260209",
        name: "web_search",
        max_uses: WEB_SEARCH_MAX_USES,
      },
    ],
    tool_choice: { type: "auto" },
    stream: true,
  };
}

async function readGlmWebSearch(
  response: Response,
): Promise<{ text: string; hits: WebSearchHit[] }> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `glm web_search returned HTTP ${response.status}: ${truncateEllipsis(text, 500)}`,
    );
  }
  if (!response.body) throw new Error("glm web_search response had no body");
  let text = "";
  const hits: WebSearchHit[] = [];
  for await (const event of parseSse(bodyChunks(response.body))) {
    if (!event.data) continue;
    if (event.data === "[DONE]") break;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const eventType = typeof data.type === "string" ? data.type : (event.event ?? "");
    if (eventType === "message_stop") break;
    if (eventType === "content_block_delta") {
      const delta = data.delta as Record<string, unknown> | undefined;
      if (typeof delta?.text === "string") text += delta.text;
      continue;
    }
    if (eventType !== "content_block_start") continue;
    const block = data.content_block as Record<string, unknown> | undefined;
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    collectSearchHits(block, hits);
  }
  return { text, hits: dedupeByUrl(hits) };
}

function collectSearchHits(block: Record<string, unknown>, hits: WebSearchHit[]): void {
  const content = Array.isArray(block.content) ? block.content : [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const hit = hitFromObject(item as Record<string, unknown>);
    if (hit) hits.push(hit);
  }
}

function hitFromObject(obj: Record<string, unknown>): WebSearchHit | null {
  const rawUrl = obj.url ?? obj.link;
  const url = typeof rawUrl === "string" ? rawUrl : "";
  if (url.length === 0) return null;
  const rawTitle = obj.title;
  const title = typeof rawTitle === "string" && rawTitle.length > 0 ? rawTitle : url;
  return { title, url };
}
