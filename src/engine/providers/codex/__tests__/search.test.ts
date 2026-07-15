import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchCodex } from "@/engine/tools/codex.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { saveFor } from "@/kernel/storage/credentials.ts";
import { config } from "../config.ts";
import { clearSessionState } from "../transport/state.ts";

let configDir: string;
const originalFetch = global.fetch;

function ctx(abortSignal?: AbortSignal): RequestContext {
  return {
    provider: "codex",
    model: "gpt-5.6-sol",
    sessionId: "codex-search-session",
    cwd: "/workspace/fixture",
    effort: "medium",
    permissionMode: "default",
    fastMode: false,
    agentic: false,
    ...(abortSignal ? { abortSignal } : {}),
  } as RequestContext;
}

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), "codex-search-test-"));
  process.env.OTHERSIDE_CONFIG_DIR = configDir;
  await saveFor("codex", {
    accessToken: "test-access",
    refreshToken: "test-refresh",
    accountId: "test-account",
    expiresAt: Date.now() + 60 * 60_000,
    installationId: "test-installation",
    windowId: "test-window",
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  clearSessionState("codex-search-session");
  delete process.env.OTHERSIDE_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
});

describe("Codex web search", () => {
  it("wires the provider to the Codex search backend", () => {
    expect(config.webSearch).toBe(searchCodex);
    expect(config.deferredOverrides?.alwaysDeclare).toContain("WebSearch");
  });

  it("calls alpha/search with Codex auth, filters, and the upstream payload", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return Promise.resolve(
        Response.json({
          output: "Official result",
          results: [{ title: "Codex", url: "https://developers.openai.com/codex" }],
        }),
      );
    }) as unknown as typeof fetch;

    const result = await searchCodex(
      {
        query: "Codex documentation",
        allowedDomains: ["openai.com"],
        blockedDomains: [],
      },
      ctx(),
    );

    expect(capturedUrl).toBe("https://chatgpt.com/backend-api/codex/alpha/search");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-access");
    expect(headers["chatgpt-account-id"]).toBe("test-account");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Accept).toBe("application/json");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      id: "codex-search-session",
      model: "gpt-5.6-sol",
      commands: {
        search_query: [{ q: "Codex documentation" }],
        response_length: "short",
      },
      settings: {
        search_context_size: "medium",
        allowed_callers: ["direct"],
        external_web_access: true,
        filters: { allowed_domains: ["openai.com"] },
      },
      max_output_tokens: 4096,
    });
    expect(result.query).toBe("Codex documentation");
    expect(result.provider).toBe("codex");
    expect(result.results).toEqual([
      "Official result",
      { title: "Codex", url: "https://developers.openai.com/codex" },
    ]);
  });

  it("rejects a response without the required output field", async () => {
    global.fetch = mock(() =>
      Promise.resolve(Response.json({ results: [] })),
    ) as unknown as typeof fetch;

    await expect(
      searchCodex({ query: "invalid", allowedDomains: [], blockedDomains: [] }, ctx()),
    ).rejects.toThrow("failed to decode codex web search response: missing output");
  });

  it("normalizes aborts while reading the response", async () => {
    const controller = new AbortController();
    global.fetch = mock(() =>
      Promise.resolve({
        status: 200,
        ok: true,
        headers: new Headers(),
        json: () => {
          controller.abort();
          return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
        },
      } as Response),
    ) as unknown as typeof fetch;

    await expect(
      searchCodex(
        { query: "cancelled", allowedDomains: [], blockedDomains: [] },
        ctx(controller.signal),
      ),
    ).rejects.toThrow("web search aborted");
  });
});
