import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { xaiStream } from "@/engine/providers/xai/stream.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { saveFor } from "@/kernel/storage/credentials.ts";

const originalFetch = globalThis.fetch;
let configDir: string;

function ctx(): RequestContext {
  return {
    provider: "xai",
    model: "grok-4.5",
    sessionId: "xai-401-stream",
    cwd: "/workspace/fixture",
    permissionMode: "default",
  } as RequestContext;
}

describe("xai stream 401 refresh-then-retry", () => {
  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "xai-stream-auth-test-"));
    process.env.OTHERSIDE_CONFIG_DIR = configDir;
    await saveFor("xai", {
      accessToken: "stale_access",
      refreshToken: "stale_refresh",
      expiresAt: Date.now() + 10 * 60_000,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OTHERSIDE_CONFIG_DIR;
    rmSync(configDir, { recursive: true, force: true });
  });

  test("adopts the persisted winner after invalid_grant and retries once", async () => {
    let responseCalls = 0;
    let refreshCalls = 0;
    let lastAuthorization = "";

    globalThis.fetch = mock(async (input, init) => {
      if (String(input).includes("/oauth2/token")) {
        refreshCalls++;
        await saveFor("xai", {
          accessToken: "winner_access",
          refreshToken: "winner_refresh",
          expiresAt: Date.now() + 60 * 60_000,
        });
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }

      responseCalls++;
      lastAuthorization = (init?.headers as Record<string, string>).Authorization ?? "";
      if (responseCalls === 1) return new Response("unauthorized", { status: 401 });
      return new Response("data: ok\n\n", { status: 200 });
    }) as unknown as typeof fetch;

    const chunks: string[] = [];
    for await (const chunk of xaiStream(
      ctx(),
      { model: "grok-4.5" },
      new AbortController().signal,
    )) {
      chunks.push(new TextDecoder().decode(chunk));
    }

    expect(refreshCalls).toBe(1);
    expect(responseCalls).toBe(2);
    expect(lastAuthorization).toBe("Bearer winner_access");
    expect(chunks.join("")).toContain("data: ok");
  });

  test("treats a second 401 as terminal", async () => {
    let responseCalls = 0;
    let refreshCalls = 0;

    globalThis.fetch = mock(async (input) => {
      if (String(input).includes("/oauth2/token")) {
        refreshCalls++;
        return new Response(
          JSON.stringify({
            access_token: "fresh_access",
            refresh_token: "fresh_refresh",
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      responseCalls++;
      return new Response("unauthorized", { status: 401 });
    }) as unknown as typeof fetch;

    await expect(async () => {
      for await (const _ of xaiStream(ctx(), { model: "grok-4.5" }, new AbortController().signal)) {
      }
    }).toThrow("HTTP 401 from grok /v1/responses");

    expect(refreshCalls).toBe(1);
    expect(responseCalls).toBe(2);
  });
});
