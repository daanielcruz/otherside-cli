import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getProviderConfig } from "@/engine/contract/registry.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import { searchDuckDuckGo } from "@/engine/tools/duckduckgo.ts";
import { buildGlmWebSearchBody, searchGlm } from "@/engine/tools/glm.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

registerAllProviders();

const configDir = join(process.cwd(), `.glm-websearch-test-${process.pid}`);
const priorConfigDir = process.env.OTHERSIDE_CONFIG_DIR;

beforeAll(() => {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "credentials.json"),
    JSON.stringify({ glm: { zcodeJwtToken: "test-key" } }),
  );
  process.env.OTHERSIDE_CONFIG_DIR = configDir;
});

afterAll(() => {
  if (priorConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = priorConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

describe("glm websearch wiring", () => {
  it("uses searchGlm (server-side web_search_20260209), never the DuckDuckGo fallback", () => {
    const cfg = getProviderConfig("glm");
    expect(cfg).toBeDefined();
    expect(cfg?.webSearch).toBe(searchGlm);
    expect(cfg?.webSearch).not.toBe(searchDuckDuckGo);
  });

  it("builds a body that targets the GLM web_search_20260209 server-side tool", () => {
    const body = buildGlmWebSearchBody("test query") as Record<string, unknown>;
    expect(body.model).toBe("GLM-5.2");
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.type).toBe("web_search_20260209");
    expect(tools[0]?.name).toBe("web_search");
    expect(body.stream).toBe(true);
  });

  it("propagates cancellation and finishes on [DONE] without waiting for EOF", async () => {
    const originalFetch = globalThis.fetch;
    const abort = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      receivedSignal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"done"}}\n\ndata: [DONE]\n\n',
            ),
          );
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const search = searchGlm({ query: "test query", allowedDomains: [], blockedDomains: [] }, {
        provider: "glm",
        sessionId: "glm-websearch-test",
        abortSignal: abort.signal,
      } as RequestContext);
      const result = await Promise.race([
        search,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 300)),
      ]);
      expect(result).not.toBeNull();
      expect(result?.results).toContain("done");
      expect(receivedSignal).toBe(abort.signal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("finishes on message_stop without waiting for EOF", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"done"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
            ),
          );
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const search = searchGlm({ query: "test query", allowedDomains: [], blockedDomains: [] }, {
        provider: "glm",
        sessionId: "glm-websearch-test",
      } as RequestContext);
      const result = await Promise.race([
        search,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 300)),
      ]);
      expect(result).not.toBeNull();
      expect(result?.results).toContain("done");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
