import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { saveFor } from "@/kernel/storage/credentials.ts";
import { streamHttp } from "../http.ts";
import { stream } from "../index.ts";
import { getTransport, snapshotForTest } from "../state.ts";
import { CodexWsClosedBeforeCompletionError } from "../ws-router.ts";
import { CodexWsHandshakeError } from "../ws-socket-pool.ts";

let configDir: string;
const originalFetch = global.fetch;

let shouldFailWsStream = false;
let wsStreamErrorToThrow: Error | null = null;
let streamWsCallCount = 0;

mock.module("@/engine/providers/codex/transport/ws.ts", () => {
  const wsMod = require("../ws.ts");
  return {
    ...wsMod,
    streamWs: async function* (ctx: unknown, body: unknown) {
      streamWsCallCount++;
      if (shouldFailWsStream && wsStreamErrorToThrow) {
        throw wsStreamErrorToThrow;
      }
      yield new Uint8Array([1, 2, 3]);
    },
  };
});

describe("Codex Transport Fixes", () => {
  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "codex-transport-test-"));
    process.env.OTHERSIDE_CONFIG_DIR = configDir;

    await saveFor("codex", {
      accessToken: "initial_token",
      refreshToken: "refresh_token",
      expiresAt: Date.now() + 10 * 60_000,
      installationId: "inst_id",
      windowId: "win_id",
    });

    shouldFailWsStream = false;
    wsStreamErrorToThrow = null;
    streamWsCallCount = 0;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.OTHERSIDE_CONFIG_DIR;
    delete process.env.OTHERSIDE_CODEX_PREWARM;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("prewarm flag - second streamHttp call for the same session does not issue a prewarm fetch", async () => {
    let prewarmCount = 0;
    global.fetch = mock((_url, init) => {
      const body = JSON.parse((init?.body as string) || "{}");
      if (body.generate === false) {
        prewarmCount++;
      }
      return Promise.resolve(new Response("data: {}\n\n", { status: 200 }));
    }) as unknown as typeof fetch;

    const ctx = {
      sessionId: "session-prewarm-test",
      abortSignal: new AbortController().signal,
      permissionMode: "safe",
      cwd: "/workspace/fixture",
    } as unknown as RequestContext;

    for await (const _ of streamHttp(ctx, { model: "test" })) {
    }
    expect(prewarmCount).toBe(1);

    for await (const _ of streamHttp(ctx, { model: "test" })) {
    }
    expect(prewarmCount).toBe(1);
  });

  it("wsStreamFailures threshold flips getTransport to http", async () => {
    const sessionId = "session-failures-test";
    const ctx = {
      sessionId,
      abortSignal: new AbortController().signal,
      permissionMode: "safe",
      cwd: "/workspace/fixture",
    } as unknown as RequestContext;

    expect(getTransport(sessionId)).toBe("ws");

    shouldFailWsStream = true;
    wsStreamErrorToThrow = new Error("codex ws stream: socket error");
    await expect(async () => {
      for await (const _ of stream(ctx, {}, ctx.abortSignal!)) {
      }
    }).toThrow("codex ws stream: socket error");
    expect(getTransport(sessionId)).toBe("ws");
    expect(snapshotForTest(sessionId)?.wsStreamFailures).toBe(1);

    wsStreamErrorToThrow = new CodexWsClosedBeforeCompletionError(1006, "abnormal");
    await expect(async () => {
      for await (const _ of stream(ctx, {}, ctx.abortSignal!)) {
      }
    }).toThrow("codex ws closed before completion");
    expect(getTransport(sessionId)).toBe("ws");
    expect(snapshotForTest(sessionId)?.wsStreamFailures).toBe(2);

    wsStreamErrorToThrow = new Error("codex ws stream: socket error");
    await expect(async () => {
      for await (const _ of stream(ctx, {}, ctx.abortSignal!)) {
      }
    }).toThrow("codex ws stream: socket error");
    expect(getTransport(sessionId)).toBe("http");
    expect(snapshotForTest(sessionId)?.wsStreamFailures).toBe(3);
  });

  it("streamHttp retries once on 401 response if token changes, and fails if unchanged", async () => {
    process.env.OTHERSIDE_CODEX_PREWARM = "0";
    let fetchCount = 0;
    let lastTokenUsed = "";

    global.fetch = mock(async (_url, init) => {
      fetchCount++;
      const authHeader = (init?.headers as Record<string, string>)?.Authorization || "";
      lastTokenUsed = authHeader.replace("Bearer ", "");

      if (fetchCount === 1) {
        await saveFor("codex", {
          accessToken: "new_token",
          refreshToken: "refresh_token",
          expiresAt: Date.now() + 10 * 60_000,
          installationId: "inst_id",
          windowId: "win_id",
        });
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response("data: chunk\n\n", { status: 200 });
    }) as unknown as typeof fetch;

    const ctx = {
      sessionId: "session-http-401-test-1",
      abortSignal: new AbortController().signal,
      permissionMode: "safe",
      cwd: "/workspace/fixture",
    } as unknown as RequestContext;

    const chunks: string[] = [];
    for await (const chunk of streamHttp(ctx, {})) {
      chunks.push(new TextDecoder().decode(chunk));
    }
    expect(fetchCount).toBe(2);
    expect(lastTokenUsed).toBe("new_token");

    fetchCount = 0;
    global.fetch = mock(async () => {
      fetchCount++;
      return new Response("Unauthorized", { status: 401 });
    }) as unknown as typeof fetch;

    const ctx2 = {
      sessionId: "session-http-401-test-2",
      abortSignal: new AbortController().signal,
      permissionMode: "safe",
      cwd: "/workspace/fixture",
    } as unknown as RequestContext;

    await expect(async () => {
      for await (const _ of streamHttp(ctx2, {})) {
      }
    }).toThrow();
    // main request + forced OAuth refresh attempt (mock rejects both)
    expect(fetchCount).toBe(2);
  });

  it("stream retries WS handshake on 401 if token changes, otherwise falls back to HTTP", async () => {
    process.env.OTHERSIDE_CODEX_PREWARM = "0";
    const sessionId = "session-ws-handshake-401";
    const ctx = {
      sessionId,
      abortSignal: new AbortController().signal,
      permissionMode: "safe",
      cwd: "/workspace/fixture",
    } as unknown as RequestContext;

    shouldFailWsStream = true;
    wsStreamErrorToThrow = new CodexWsHandshakeError("Unexpected server response: 401");

    let fetchCount = 0;
    global.fetch = mock(() => {
      fetchCount++;
      return Promise.resolve(new Response("data: http_chunk\n\n", { status: 200 }));
    }) as unknown as typeof fetch;

    mock.module("@/engine/providers/codex/transport/ws.ts", () => {
      const wsMod = require("../ws.ts");
      return {
        ...wsMod,
        streamWs: async function* (c: unknown, b: unknown) {
          streamWsCallCount++;
          if (streamWsCallCount === 1) {
            await saveFor("codex", {
              accessToken: "new_ws_token",
              refreshToken: "refresh_token",
              expiresAt: Date.now() + 10 * 60_000,
              installationId: "inst_id",
              windowId: "win_id",
            });
            throw new CodexWsHandshakeError("Unexpected server response: 401");
          }
          yield new Uint8Array([9, 9, 9]);
        },
      };
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of stream(ctx, {}, ctx.abortSignal!)) {
      chunks.push(chunk);
    }
    expect(streamWsCallCount).toBe(2);
    expect(chunks[0]).toEqual(new Uint8Array([9, 9, 9]));
    expect(fetchCount).toBe(0);
  });
});
