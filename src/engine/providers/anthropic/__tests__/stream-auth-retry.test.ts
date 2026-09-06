import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runForkLoopInContext } from "@/engine/background/subagents/fork/loop-runner.ts";
import type { ForkSpec } from "@/engine/background/subagents/fork/types.ts";
import { forceRefreshTokens } from "@/engine/providers/anthropic/auth.ts";
import { anthropicStream } from "@/engine/providers/anthropic/stream.ts";
import { registerAllBuiltins } from "@/engine/tools/register-builtins.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { saveFor } from "@/kernel/storage/credentials.ts";

const originalFetch = globalThis.fetch;
// Credential material is never written outside a home this test owns and removes.
let credentialHome: string | undefined;
let savedConfigDir: string | undefined;
let savedEphemeralSessionsDir: string | undefined;

beforeAll(() => {
  registerAllBuiltins();
});

function ctx(): RequestContext {
  return {
    provider: "anthropic",
    model: "claude-fable-5",
    effort: "high",
    permissionMode: "default",
    sessionId: "anthropic-401-stream",
    cwd: "/tmp",
  } as RequestContext;
}

describe("anthropic stream 401 refresh-then-retry", () => {
  beforeEach(async () => {
    savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    savedEphemeralSessionsDir = process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
    credentialHome = mkdtempSync(join(tmpdir(), "otherside-anthropic-401-"));
    process.env.OTHERSIDE_CONFIG_DIR = credentialHome;
    process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = credentialHome;
    await saveFor("anthropic", {
      accessToken: "stale_token",
      refreshToken: "refresh_token",
      expiresAt: Date.now() + 10 * 60_000,
      scopes: ["org:create_api_key", "user:profile", "user:inference"],
      accountUuid: "acct",
      accountEmail: "user@example.com",
      organizationName: "org",
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
    if (savedEphemeralSessionsDir === undefined)
      delete process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
    else process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = savedEphemeralSessionsDir;
    if (credentialHome !== undefined) rmSync(credentialHome, { recursive: true, force: true });
    credentialHome = undefined;
  });

  it("refreshes once on 401 when the access token rotates, then retries the request", async () => {
    let messagesCalls = 0;
    let lastAuth = "";

    globalThis.fetch = mock(async (input, init) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        return new Response(
          JSON.stringify({
            token_type: "Bearer",
            access_token: "fresh_token",
            refresh_token: "refresh_token",
            expires_in: 3600,
            scope: "org:create_api_key user:profile user:inference",
            token_uuid: "tok",
            organization: { uuid: "org", name: "org" },
            account: { uuid: "acct", email_address: "user@example.com" },
          }),
          { status: 200 },
        );
      }

      messagesCalls += 1;
      const headers = init?.headers as Record<string, string>;
      lastAuth = headers.Authorization ?? "";
      if (messagesCalls === 1) {
        return new Response("unauthorized", { status: 401 });
      }
      return new Response("data: ok\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const chunks: string[] = [];
    for await (const chunk of anthropicStream(
      ctx(),
      { model: "claude-fable-5" },
      new AbortController().signal,
    )) {
      chunks.push(new TextDecoder().decode(chunk));
    }

    expect(messagesCalls).toBe(2);
    expect(lastAuth).toBe("Bearer fresh_token");
    expect(chunks.join("")).toContain("data: ok");
  });

  it("fails without a second messages call when refresh cannot rotate the token", async () => {
    let messagesCalls = 0;
    let tokenCalls = 0;

    globalThis.fetch = mock(async (input) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        tokenCalls += 1;
        return new Response("refresh failed", { status: 500 });
      }
      messagesCalls += 1;
      return new Response("unauthorized", { status: 401 });
    }) as unknown as typeof fetch;

    await expect(async () => {
      for await (const _ of anthropicStream(
        ctx(),
        { model: "claude-fable-5" },
        new AbortController().signal,
      )) {
      }
    }).toThrow(/HTTP 401 from \/v1\/messages/);

    expect(messagesCalls).toBe(1);
    expect(tokenCalls).toBe(1);
  });

  it("uses the winner's persisted tokens after invalid_grant during refresh", async () => {
    let messagesCalls = 0;
    let tokenCalls = 0;
    let lastAuth = "";

    globalThis.fetch = mock(async (input, init) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        tokenCalls += 1;
        await saveFor("anthropic", {
          accessToken: "winner_access_token",
          refreshToken: "winner_refresh_token",
          expiresAt: Date.now() + 60 * 60_000,
          scopes: ["user:inference"],
        });
        return new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "Refresh token not found or invalid",
          }),
          { status: 400 },
        );
      }

      messagesCalls += 1;
      const headers = init?.headers as Record<string, string>;
      lastAuth = headers.Authorization ?? "";
      if (messagesCalls === 1) return new Response("unauthorized", { status: 401 });
      return new Response("data: ok\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    for await (const _ of anthropicStream(
      ctx(),
      { model: "claude-fable-5" },
      new AbortController().signal,
    )) {
    }

    expect(tokenCalls).toBe(1);
    expect(messagesCalls).toBe(2);
    expect(lastAuth).toBe("Bearer winner_access_token");
  });

  it("single-flights concurrent in-process refreshes", async () => {
    let tokenCalls = 0;
    let releaseRefresh: (() => void) | undefined;
    let refreshStarted: (() => void) | undefined;
    const refreshStartedPromise = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    const releaseRefreshPromise = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });

    globalThis.fetch = mock(async (input) => {
      if (!String(input).includes("/oauth/token")) {
        throw new Error("unexpected messages request");
      }
      tokenCalls += 1;
      refreshStarted?.();
      await releaseRefreshPromise;
      return new Response(
        JSON.stringify({
          token_type: "Bearer",
          access_token: "fresh_token",
          refresh_token: "fresh_refresh_token",
          expires_in: 3600,
          scope: "user:inference",
          token_uuid: "tok",
          organization: { uuid: "org", name: "org" },
          account: { uuid: "acct", email_address: "placeholder@example.invalid" },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const first = forceRefreshTokens();
    await refreshStartedPromise;
    const second = forceRefreshTokens();

    expect(tokenCalls).toBe(1);
    releaseRefresh?.();
    const [firstTokens, secondTokens] = await Promise.all([first, second]);
    expect(firstTokens.accessToken).toBe("fresh_token");
    expect(secondTokens.accessToken).toBe("fresh_token");
  });

  it("treats a second 401 after refresh as terminal", async () => {
    let messagesCalls = 0;
    let tokenCalls = 0;

    globalThis.fetch = mock(async (input) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        tokenCalls += 1;
        return new Response(
          JSON.stringify({
            token_type: "Bearer",
            access_token: "fresh_token",
            refresh_token: "fresh_refresh_token",
            expires_in: 3600,
            scope: "user:inference",
            token_uuid: "tok",
            organization: { uuid: "org", name: "org" },
            account: { uuid: "acct", email_address: "placeholder@example.invalid" },
          }),
          { status: 200 },
        );
      }
      messagesCalls += 1;
      return new Response("still unauthorized", { status: 401 });
    }) as unknown as typeof fetch;

    await expect(async () => {
      for await (const _ of anthropicStream(
        ctx(),
        { model: "claude-fable-5" },
        new AbortController().signal,
      )) {
      }
    }).toThrow(/HTTP 401 from \/v1\/messages/);

    expect(messagesCalls).toBe(2);
    expect(tokenCalls).toBe(1);
  });

  it("retries an Anthropic fork with credentials reloaded after its 401", async () => {
    let messagesCalls = 0;
    let tokenCalls = 0;
    let lastAuth = "";
    const forkText =
      "The fork retried its request after reloading rotated credentials and completed the assigned task with a verified, useful response.";

    globalThis.fetch = mock(async (input, init) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        tokenCalls += 1;
        throw new Error("the fork should use the credentials another flow already persisted");
      }

      messagesCalls += 1;
      const headers = init?.headers as Record<string, string>;
      lastAuth = headers.Authorization ?? "";
      if (messagesCalls === 1) {
        await saveFor("anthropic", {
          accessToken: "winner_access_token",
          refreshToken: "winner_refresh_token",
          expiresAt: Date.now() + 60 * 60_000,
          scopes: ["user:inference"],
        });
        return new Response("unauthorized", { status: 401 });
      }
      return new Response(
        [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_fork"}}\n\n',
          `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(forkText)}}}\n\n`,
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const spec: ForkSpec = {
      name: "auth-retry-fork",
      body: "Verify auth recovery in the fork stream.",
      allowSet: new Set(),
      prompt: "Complete the auth recovery check.",
      ctx: ctx(),
    };
    const result = await runForkLoopInContext(spec, "fork-auth-retry", spec.ctx);

    expect(result.isError).toBe(false);
    expect(result.output).toContain(forkText);
    expect(messagesCalls).toBe(2);
    expect(tokenCalls).toBe(0);
    expect(lastAuth).toBe("Bearer winner_access_token");
  });
});
