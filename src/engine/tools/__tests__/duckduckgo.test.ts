import { afterEach, describe, expect, it, mock } from "bun:test";
import { searchDuckDuckGo } from "@/engine/tools/duckduckgo.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const originalFetch = global.fetch;

const ctx = {
  provider: "minimax",
  sessionId: "web-search-test",
} as RequestContext;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("DuckDuckGo web search fallback", () => {
  it("uses Brave web results when Instant Answer has no general results", async () => {
    const urls: string[] = [];
    global.fetch = mock((input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith("https://api.duckduckgo.com/")) {
        return Promise.resolve(Response.json({}));
      }
      return Promise.resolve(
        new Response(
          `<div class="snippet result" data-type="web"><div><a href="https://docs.x.ai/overview"><div class="title search-snippet-title" title="xAI Docs &amp; API">xAI Docs</div></a></div></div>`,
          { status: 200, headers: { "Content-Type": "text/html" } },
        ),
      );
    }) as unknown as typeof fetch;

    const result = await searchDuckDuckGo(
      { query: "xAI API docs", allowedDomains: ["x.ai"], blockedDomains: [] },
      ctx,
    );

    expect(urls).toHaveLength(2);
    expect(urls[1]).toStartWith("https://search.brave.com/search?");
    expect(result.results).toEqual([
      { title: "xAI Docs & API", url: "https://docs.x.ai/overview" },
    ]);
  });

  it("does not call the fallback when Instant Answer returns a result", async () => {
    let calls = 0;
    global.fetch = mock(() => {
      calls++;
      return Promise.resolve(
        Response.json({
          Heading: "DeepSeek",
          AbstractURL: "https://api-docs.deepseek.com/",
        }),
      );
    }) as unknown as typeof fetch;

    const result = await searchDuckDuckGo(
      { query: "DeepSeek", allowedDomains: [], blockedDomains: [] },
      { ...ctx, provider: "deepseek" } as RequestContext,
    );

    expect(calls).toBe(1);
    expect(result.results).toEqual([{ title: "DeepSeek", url: "https://api-docs.deepseek.com/" }]);
  });
});
