import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import { config } from "@/engine/providers/codex/config.ts";
import { buildHeaders, RESPONSES_WS_URL } from "@/engine/providers/codex/fingerprint.ts";
import { buildCodexRequestMetadata } from "@/engine/providers/codex/metadata.ts";
import { translateRequestCodex } from "@/engine/providers/codex/translate.ts";
import {
  type CodexSessionState,
  clearSessionState,
  getSessionState,
} from "@/engine/providers/codex/transport/state.ts";
import { buildWsFrame } from "@/engine/providers/codex/transport/ws.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

registerAllProviders();

const MESSAGES: Message[] = [
  { role: "system", content: [{ type: "text", text: "fixed-system-instruction" }] },
  { role: "user", content: [{ type: "text", text: "explain the build" }] },
  {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_fixture",
        name: "Bash",
        input: { command: "make build-install" },
      },
    ],
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_fixture", content: "ok" }],
  },
  { role: "user", content: [{ type: "text", text: "now ship it" }] },
];

const TOOLS: unknown[] = [
  {
    name: "Bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

function sha256(str: string): string {
  return createHash("sha256").update(str).digest("hex");
}

function stableWireSnapshot(
  frame: Record<string, unknown>,
  headers: Record<string, string>,
): {
  body: Record<string, unknown>;
  bodyHash: string;
  headers: Record<string, string>;
} {
  const body = structuredClone(frame);
  const clientMetadata = body.client_metadata as Record<string, string>;
  clientMetadata["x-codex-turn-metadata"] = stableTurnMetadata(
    clientMetadata["x-codex-turn-metadata"],
  );
  const stableHeaders = { ...headers };
  stableHeaders["x-codex-turn-metadata"] = stableTurnMetadata(
    stableHeaders["x-codex-turn-metadata"],
  );
  return {
    body,
    bodyHash: sha256(JSON.stringify(body)),
    headers: stableHeaders,
  };
}

function stableTurnMetadata(value: string | undefined): string {
  if (value === undefined) throw new Error("missing x-codex-turn-metadata");
  const metadata = JSON.parse(value) as Record<string, unknown>;
  if (metadata.turn_started_at_unix_ms !== undefined) {
    metadata.turn_started_at_unix_ms = "<turn-started-at>";
  }
  if (metadata.sandbox !== undefined) {
    // The golden keeps the Darwin wire spelling; runtime assertions cover host-specific values.
    metadata.sandbox = "seatbelt";
  }
  return JSON.stringify(metadata);
}

describe("codex wire-request-golden", () => {
  let priorScratchpadDir: string | undefined;

  beforeEach(() => {
    priorScratchpadDir = process.env.OTHERSIDE_SCRATCHPAD_DIR;
    process.env.OTHERSIDE_SCRATCHPAD_DIR = "/tmp/otherside-fixture/scratchpad";
  });

  afterEach(() => {
    if (priorScratchpadDir === undefined) {
      delete process.env.OTHERSIDE_SCRATCHPAD_DIR;
    } else {
      process.env.OTHERSIDE_SCRATCHPAD_DIR = priorScratchpadDir;
    }
  });

  it("main", () => {
    const ctx: RequestContext = {
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      permissionMode: "default",
      sessionId: "session-fixture",
      cwd: "/workspace/fixture",
      turnId: "turn-fixture",
      agentic: true,
    };

    const session: CodexSessionState = {
      conversationId: ctx.sessionId,
      threadId: "thread-fixture",
      windowGeneration: 0,
      transport: "ws",
      fallbackReason: null,
      encryptedReasoningRejected: false,
    };

    const build = () => {
      const body = translateRequestCodex(ctx, MESSAGES, TOOLS) as Record<string, unknown>;
      const requestMetadata = buildCodexRequestMetadata({
        ctx,
        installationId: "installation-fixture",
        mainSessionId: session.conversationId,
        mainThreadId: session.threadId,
        windowGeneration: session.windowGeneration,
        requestKind: "turn",
      });
      const frame = buildWsFrame(body, requestMetadata);
      const headers = buildHeaders({
        bearer: "Bearer fixture-token",
        accountId: "account-fixture",
        requestMetadata,
        transport: "ws",
        wsKey: "fixture-websocket-key",
      });

      return {
        body,
        frame,
        headers,
        turnMetadataHeaderStr: requestMetadata.turnMetadataHeader,
      };
    };

    const res1 = build();
    const res2 = build();

    expect(res1.body).toEqual(res2.body);
    expect(res1.frame).toEqual(res2.frame);
    expect(res1.headers).toEqual(res2.headers);

    expect(JSON.stringify(res1.body)).toBe(JSON.stringify(res2.body));
    expect(JSON.stringify(res1.frame)).toBe(JSON.stringify(res2.frame));
    expect(JSON.stringify(res1.headers)).toBe(JSON.stringify(res2.headers));

    const meta = JSON.parse(res1.turnMetadataHeaderStr);
    expect(meta).toMatchObject({
      installation_id: "installation-fixture",
      session_id: "session-fixture",
      thread_id: "thread-fixture",
      thread_source: "user",
      turn_id: "turn-fixture",
      window_id: "thread-fixture:0",
      request_kind: "turn",
    });
    expect(Number.isInteger(meta.turn_started_at_unix_ms)).toBe(true);
    expect(meta.workspaces).toBeUndefined();
    expect((res1.frame.client_metadata as Record<string, string>).session_id).toBe(
      "session-fixture",
    );
    expect(res1.headers.session_id).toBe("session-fixture");
    expect(res1.body.prompt_cache_key).toBe("session-fixture");
    expect(res1.body.store).toBe(false);
    expect(res1.body.previous_response_id).toBeUndefined();
    expect(res1.frame.store).toBe(false);
    expect(res1.frame.previous_response_id).toBeUndefined();

    const redactedHeaders = { ...res1.headers };
    redactedHeaders.Authorization = "<redacted>";
    redactedHeaders["Sec-WebSocket-Key"] = "<redacted>";

    expect({
      url: RESPONSES_WS_URL,
      ...stableWireSnapshot(res1.frame, redactedHeaders),
    }).toMatchSnapshot();
  });

  it("fork", () => {
    const ctx: RequestContext = {
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      permissionMode: "default",
      sessionId: "session-fixture",
      cwd: "/workspace/fixture",
      turnId: "turn-fixture",
      agentic: true,
      subagentLabel: "collab_spawn",
      agentOwnerId: "fork-fixture",
      parentThreadId: "session-fixture",
      suppressThinkingSummary: true,
    };

    const session: CodexSessionState = {
      conversationId: ctx.sessionId,
      threadId: "thread-fixture",
      windowGeneration: 0,
      transport: "ws",
      fallbackReason: null,
      encryptedReasoningRejected: false,
    };

    const build = () => {
      const body = translateRequestCodex(ctx, MESSAGES, TOOLS) as Record<string, unknown>;
      const requestMetadata = buildCodexRequestMetadata({
        ctx,
        installationId: "installation-fixture",
        mainSessionId: session.conversationId,
        mainThreadId: session.threadId,
        windowGeneration: session.windowGeneration,
        requestKind: "turn",
      });
      const frame = buildWsFrame(body, requestMetadata);
      const headers = buildHeaders({
        bearer: "Bearer fixture-token",
        accountId: "account-fixture",
        requestMetadata,
        transport: "ws",
        wsKey: "fixture-websocket-key",
      });

      return {
        body,
        frame,
        headers,
        turnMetadataHeaderStr: requestMetadata.turnMetadataHeader,
      };
    };

    const res1 = build();
    const res2 = build();

    expect(res1.body).toEqual(res2.body);
    expect(res1.frame).toEqual(res2.frame);
    expect(res1.headers).toEqual(res2.headers);

    expect(JSON.stringify(res1.body)).toBe(JSON.stringify(res2.body));
    expect(JSON.stringify(res1.frame)).toBe(JSON.stringify(res2.frame));
    expect(JSON.stringify(res1.headers)).toBe(JSON.stringify(res2.headers));

    const meta = JSON.parse(res1.turnMetadataHeaderStr);
    expect(meta).toMatchObject({
      installation_id: "installation-fixture",
      thread_source: "subagent",
      turn_id: "",
      request_kind: "turn",
    });
    expect(meta.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(meta.thread_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(meta.window_id).toBe(`${meta.thread_id}:0`);
    expect(Number.isInteger(meta.turn_started_at_unix_ms)).toBe(true);
    expect(meta.workspaces).toBeUndefined();
    expect((res1.frame.client_metadata as Record<string, string>).session_id).toBe(meta.session_id);
    expect(res1.headers.session_id).toBe(meta.session_id);
    expect(res1.headers["x-codex-parent-thread-id"]).toBe("session-fixture");
    expect(res1.body.prompt_cache_key).toBe("session-fixture:fork:fork-fixture");
    expect(res1.body.store).toBe(false);
    expect(res1.body.previous_response_id).toBeUndefined();
    expect(res1.frame.store).toBe(false);
    expect(res1.frame.previous_response_id).toBeUndefined();

    expect(res1.body.reasoning).toEqual({ effort: "high", context: "all_turns" });
    expect(res1.body.include).toContain("reasoning.encrypted_content");
    expect(res1.frame.reasoning).toEqual({ effort: "high", context: "all_turns" });
    expect(res1.frame.include).toContain("reasoning.encrypted_content");
    expect((res1.body.reasoning as Record<string, unknown>).summary).toBeUndefined();
    expect((res1.frame.reasoning as Record<string, unknown>).summary).toBeUndefined();

    const redactedHeaders = { ...res1.headers };
    redactedHeaders.Authorization = "<redacted>";
    redactedHeaders["Sec-WebSocket-Key"] = "<redacted>";

    expect({
      url: RESPONSES_WS_URL,
      ...stableWireSnapshot(res1.frame, redactedHeaders),
    }).toMatchSnapshot();
  });

  it("keeps prewarm in the current window without a turn identity", () => {
    const ctx: RequestContext = {
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "medium",
      permissionMode: "default",
      sessionId: "prewarm-session-fixture",
      cwd: "/workspace/fixture",
    };
    const requestMetadata = buildCodexRequestMetadata({
      ctx,
      installationId: "installation-fixture",
      mainSessionId: ctx.sessionId,
      mainThreadId: "prewarm-thread-fixture",
      windowGeneration: 2,
      requestKind: "prewarm",
    });

    expect(requestMetadata.turnMetadata).toEqual({
      installation_id: "installation-fixture",
      session_id: "prewarm-session-fixture",
      thread_id: "prewarm-thread-fixture",
      thread_source: "user",
      turn_id: "",
      window_id: "prewarm-thread-fixture:2",
      sandbox:
        process.platform === "darwin"
          ? "seatbelt"
          : process.platform === "linux"
            ? "landlock"
            : "none",
      request_kind: "prewarm",
      workspaces: {},
    });
    expect(requestMetadata.turnMetadata.turn_started_at_unix_ms).toBeUndefined();
  });

  it("keeps the start timestamp stable across contexts for one logical turn", async () => {
    const turnId = `turn-fixture-${crypto.randomUUID()}`;
    const makeMetadata = () =>
      buildCodexRequestMetadata({
        ctx: {
          cwd: "/workspace/fixture",
          permissionMode: "default",
          turnId,
        },
        installationId: "installation-fixture",
        mainSessionId: "session-fixture",
        mainThreadId: "thread-fixture",
        windowGeneration: 0,
        requestKind: "turn",
      });

    const first = makeMetadata();
    await Bun.sleep(5);
    const second = makeMetadata();

    expect(second.turnMetadata.turn_id).toBe(first.turnMetadata.turn_id);
    expect(second.turnMetadata.turn_started_at_unix_ms).toBe(
      first.turnMetadata.turn_started_at_unix_ms,
    );
  });

  it("advances only the main window generation through the compaction hook", () => {
    const sessionId = `window-fixture-${crypto.randomUUID()}`;
    const ctx: RequestContext = {
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "medium",
      permissionMode: "default",
      sessionId,
      cwd: "/workspace/fixture",
    };
    clearSessionState(sessionId);
    const state = getSessionState(sessionId);
    const initialThreadId = state.threadId;

    config.onCompactionSucceeded?.(ctx);

    const advanced = getSessionState(sessionId);
    expect(advanced.threadId).toBe(initialThreadId);
    expect(advanced.windowGeneration).toBe(1);
    clearSessionState(sessionId);
  });
});
