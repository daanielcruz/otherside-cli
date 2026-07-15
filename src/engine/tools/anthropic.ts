import {
  ANTHROPIC_BETA_WEB_SEARCH,
  API_MESSAGES_URL,
  fingerprint,
} from "@/engine/providers/anthropic/_infra/fingerprint.ts";
import { authorizationHeader } from "@/engine/providers/anthropic/auth.ts";
import { applyCchAttestation } from "@/engine/providers/anthropic/cch.ts";
import { anthropicEnvelopeDefaults } from "@/engine/providers/anthropic/envelope.ts";
import { SYSTEM_OPENER, systemBillingHeader } from "@/engine/providers/anthropic/preamble.ts";
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

export async function searchAnthropic(
  input: WebSearchInput,
  ctx: RequestContext,
): Promise<WebSearchPayload> {
  const started = Date.now();
  const auth = await authorizationHeader();
  // Web search inherits the session model, querying the main-loop model instead of a pinned tier.
  const fp = fingerprint(ctx);
  const resp = await fetch(API_MESSAGES_URL, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "User-Agent": fp.userAgent,
      ...fp.extraHeaders,
      "anthropic-beta": ANTHROPIC_BETA_WEB_SEARCH,
    },
    body: applyCchAttestation(JSON.stringify(buildBody(input, ctx.model))),
  });
  const results = await readAnthropic(resp);
  const filtered = filterResults(results.hits, input.allowedDomains, input.blockedDomains).slice(
    0,
    8,
  );
  const out: WebSearchPayload["results"] = [];
  if (results.text.trim().length > 0) out.push(results.text.trim());
  out.push(...filtered);
  if (out.length === 0) out.push(`No Anthropic web_search results found for query: ${input.query}`);
  return {
    query: input.query,
    provider: ctx.provider,
    results: out,
    durationSeconds: (Date.now() - started) / 1000,
  };
}

function buildBody(input: WebSearchInput, model: string): Record<string, unknown> {
  const firstMessageText = `Perform a web search for the query: ${input.query}`;
  return {
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: firstMessageText,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ],
    system: [
      { type: "text", text: systemBillingHeader(firstMessageText) },
      {
        type: "text",
        text: SYSTEM_OPENER,
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: "You are an assistant for performing a web search tool use",
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [toolConfig(input)],
    ...anthropicEnvelopeDefaults(),
  };
}

function toolConfig(input: WebSearchInput): Record<string, unknown> {
  const cfg: Record<string, unknown> = {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: 8,
  };
  if (input.allowedDomains.length > 0) cfg.allowed_domains = input.allowedDomains;
  if (input.blockedDomains.length > 0) cfg.blocked_domains = input.blockedDomains;
  return cfg;
}

async function readAnthropic(resp: Response): Promise<{ text: string; hits: WebSearchHit[] }> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `anthropic web_search returned HTTP ${resp.status}: ${truncateEllipsis(text, 500)}`,
    );
  }
  if (!resp.body) throw new Error("anthropic web_search response had no body");
  let text = "";
  const hits: WebSearchHit[] = [];
  for await (const ev of parseSse(bodyChunks(resp.body))) {
    if (!ev.data || ev.data === "[DONE]") continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ty = typeof data.type === "string" ? data.type : (ev.event ?? "");
    if (ty === "content_block_delta") {
      const delta = data.delta as Record<string, unknown> | undefined;
      if (typeof delta?.text === "string") text += delta.text;
      continue;
    }
    if (ty !== "content_block_start") continue;
    const block = data.content_block as Record<string, unknown> | undefined;
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    if (block.type !== "web_search_tool_result") continue;
    const content = Array.isArray(block.content) ? block.content : [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const title = typeof obj.title === "string" ? obj.title : "";
      const url = typeof obj.url === "string" ? obj.url : "";
      if (url) hits.push({ title: title || url, url });
    }
  }
  return { text, hits: dedupeByUrl(hits) };
}
