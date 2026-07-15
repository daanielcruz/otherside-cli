import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  dedupeByUrl,
  filterResults,
  type WebSearchHit,
  type WebSearchInput,
  type WebSearchPayload,
} from "./common.ts";

interface DuckTopic {
  FirstURL?: string;
  Text?: string;
  Result?: string;
  Topics?: DuckTopic[];
}

interface DuckResponse {
  AbstractText?: string;
  AbstractURL?: string;
  Heading?: string;
  RelatedTopics?: DuckTopic[];
}

export async function searchDuckDuckGo(
  input: WebSearchInput,
  ctx: RequestContext,
): Promise<WebSearchPayload> {
  const started = Date.now();
  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", input.query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("skip_disambig", "1");
  const resp = await fetch(url, ctx.abortSignal ? { signal: ctx.abortSignal } : undefined);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`duckduckgo returned HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = (await resp.json()) as DuckResponse;
  const hits: WebSearchHit[] = [];
  if (data.AbstractURL) {
    hits.push({
      title: data.Heading?.trim() || data.AbstractText?.trim() || data.AbstractURL,
      url: data.AbstractURL,
    });
  }
  collectTopics(data.RelatedTopics ?? [], hits);
  let filtered = dedupeByUrl(filterResults(hits, input.allowedDomains, input.blockedDomains)).slice(
    0,
    8,
  );
  if (filtered.length === 0) {
    filtered = await searchBrave(input, ctx);
  }
  const results =
    filtered.length > 0 ? filtered : [`No web search results found for query: ${input.query}`];
  return {
    query: input.query,
    provider: ctx.provider,
    results,
    durationSeconds: (Date.now() - started) / 1000,
  };
}

async function searchBrave(input: WebSearchInput, ctx: RequestContext): Promise<WebSearchHit[]> {
  const url = new URL("https://search.brave.com/search");
  url.searchParams.set("q", input.query);
  url.searchParams.set("source", "web");
  const resp = await fetch(url, {
    headers: {
      Accept: "text/html",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
    ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`brave search returned HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  const html = await resp.text();
  const hits: WebSearchHit[] = [];
  const blocks = html.split(/<div class="snippet[^>]*data-type="web"[^>]*>/i).slice(1, 25);
  for (const block of blocks) {
    const href = block.match(/<a href="([^"]+)"/i)?.[1];
    const titleMatch = block.match(
      /<div class="title search-snippet-title[^"]*"(?: title="([^"]*)")?>([\s\S]*?)<\/div>/i,
    );
    if (!href || !titleMatch) continue;
    const url = decodeHtml(href);
    if (!/^https?:\/\//i.test(url)) continue;
    const title = decodeHtml(titleMatch[1] || titleMatch[2] || "")
      .replace(/<[^>]+>/g, "")
      .trim();
    hits.push({ title: title || url, url });
  }
  return dedupeByUrl(filterResults(hits, input.allowedDomains, input.blockedDomains)).slice(0, 8);
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function collectTopics(topics: DuckTopic[], out: WebSearchHit[]): void {
  for (const topic of topics) {
    if (Array.isArray(topic.Topics)) {
      collectTopics(topic.Topics, out);
      continue;
    }
    if (!topic.FirstURL) continue;
    out.push({
      title: textTitle(topic.Text ?? topic.Result ?? topic.FirstURL),
      url: topic.FirstURL,
    });
  }
}

function textTitle(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 120) return trimmed;
  return `${trimmed.slice(0, 117)}...`;
}
