import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  beginPromptCacheAttempt,
  finishPromptCacheAttempt,
  type PromptCacheDiagnosticRecord,
  recordPromptCacheEvent,
  resetPromptCacheDiagnosticsForTests,
  setPromptCacheDiagnosticSinkForTests,
} from "@/devtools/prompt-cache.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const ENV_KEY = "OTHERSIDE_PROMPT_CACHE_DIAG";
const originalEnv = process.env[ENV_KEY];
const records: PromptCacheDiagnosticRecord[] = [];

beforeEach(() => {
  process.env[ENV_KEY] = "1";
  records.length = 0;
  resetPromptCacheDiagnosticsForTests();
  setPromptCacheDiagnosticSinkForTests((_sessionId, record) => records.push(record));
});

afterAll(() => {
  resetPromptCacheDiagnosticsForTests();
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
});

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    provider: "anthropic",
    model: "fixture-model",
    effort: "high",
    permissionMode: "default",
    sessionId: "fixture-session",
    cwd: "/workspace/project",
    ...overrides,
  };
}

function requestBody(
  options: {
    messages?: string[];
    system?: string;
    toolDescription?: string;
    model?: string;
    secret?: string;
  } = {},
): Record<string, unknown> {
  const messages: Array<{
    role: string;
    content: Array<{
      type: string;
      text: string;
      cache_control?: { type: string; ttl: string };
    }>;
  }> = (options.messages ?? ["first-fixture-turn"]).map((text, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text }],
  }));
  const lastMessage = messages.at(-1);
  const lastBlock = lastMessage?.content[0];
  if (lastMessage?.role === "user" && lastBlock) {
    lastBlock.cache_control = { type: "ephemeral", ttl: "1h" };
  }
  return {
    model: options.model ?? "fixture-model",
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: options.system ?? "stable-system-fixture",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    tools: [
      {
        name: "Read",
        description: options.toolDescription ?? "stable-tool-fixture",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "mcp__fixture_server__lookup",
        description: "external fixture",
        input_schema: { type: "object", properties: {} },
      },
    ],
    messages,
    metadata: { user_id: "opaque-fixture" },
    ...(options.secret === undefined ? {} : { authorization: options.secret }),
  };
}

function complete(options: {
  ctx?: RequestContext;
  body?: unknown;
  read?: number;
  creation?: number;
  input?: number;
  output?: number;
  nowMs: number;
  attempt?: number;
  resumed?: boolean;
  stopReason?: string;
  outcome?: "completed" | "transport_error" | "aborted";
}): PromptCacheDiagnosticRecord {
  const attempt = beginPromptCacheAttempt({
    ctx: options.ctx ?? context(),
    body: options.body ?? requestBody(),
    attempt: options.attempt ?? 1,
    resumed: options.resumed ?? false,
    nowMs: options.nowMs,
  });
  expect(attempt).not.toBeNull();
  recordPromptCacheEvent(attempt, {
    kind: "message_start",
    id: `msg-${options.nowMs}`,
    requestId: `req-${options.nowMs}`,
  });
  recordPromptCacheEvent(attempt, {
    kind: "usage",
    ...(options.input === undefined ? {} : { inputTokens: options.input }),
    ...(options.output === undefined ? {} : { outputTokens: options.output }),
    ...(options.creation === undefined ? {} : { cacheCreationInputTokens: options.creation }),
    ...(options.read === undefined ? {} : { cacheReadInputTokens: options.read }),
  });
  recordPromptCacheEvent(attempt, {
    kind: "message_stop",
    stop_reason: options.stopReason ?? "stop",
  });
  finishPromptCacheAttempt(attempt, options.outcome ?? "completed", options.nowMs);
  const record = records.at(-1);
  if (!record) throw new Error("missing prompt-cache diagnostic record");
  return record;
}

function establishAnthropicBaseline(nowMs = 1_000): PromptCacheDiagnosticRecord {
  return complete({ nowMs, read: 0, creation: 26_000, input: 4_000, output: 20 });
}

describe("prompt-cache diagnostics", () => {
  it("is fully inert by default", () => {
    delete process.env[ENV_KEY];
    const body = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("disabled diagnostics inspected the body");
        },
      },
    );

    expect(
      beginPromptCacheAttempt({
        ctx: context(),
        body,
        attempt: 1,
        resumed: false,
      }),
    ).toBeNull();
    expect(records).toHaveLength(0);
  });

  it("fails closed when an enabled request cannot be projected", () => {
    const body = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("fixture projection failure");
        },
      },
    );

    expect(
      beginPromptCacheAttempt({
        ctx: context(),
        body,
        attempt: 1,
        resumed: false,
      }),
    ).toBeNull();
    expect(records).toHaveLength(0);
  });

  it("logs title requests without comparing them to the main cache lineage", () => {
    const title = complete({
      ctx: context({ cacheRole: "title", requestRole: "title", agentic: false }),
      nowMs: 1_000,
      read: 0,
      creation: 26_000,
    });

    expect(title.classification).toBe("excluded");
    expect(title.reasonCodes).toEqual(["role_title"]);
    expect(title.role).toBe("title");
  });

  it("establishes a baseline and accepts a healthy Anthropic continuation", () => {
    const baseline = establishAnthropicBaseline();
    const healthy = complete({
      nowMs: 2_000,
      read: 26_000,
      creation: 4_500,
      body: requestBody({ messages: ["first-fixture-turn", "reply", "follow-up"] }),
    });

    expect(baseline.classification).toBe("baseline");
    expect(healthy.classification).toBe("healthy");
    expect(healthy.comparison.expectedCacheReadTokens).toBe(26_000);
    expect(healthy.comparison.commonMessagePrefix).toBe(1);
  });

  it("flags the observed Fable-shaped failed reuse", () => {
    establishAnthropicBaseline();
    const suspect = complete({
      nowMs: 2_000,
      read: 0,
      creation: 26_100,
      body: requestBody({ messages: ["first-fixture-turn", "reply", "follow-up"] }),
    });

    expect(suspect.classification).toBe("suspected_break");
    expect(suspect.reasonCodes).toEqual(["stable_prefix_cache_drop"]);
    expect(suspect.comparison.missingCacheReadTokens).toBe(26_000);
  });

  it("does not flag an exact 5% drop or an absolute drop below 2k", () => {
    complete({ nowMs: 1_000, read: 40_000, creation: 0 });
    const exactBoundary = complete({
      nowMs: 2_000,
      read: 38_000,
      body: requestBody({ messages: ["first-fixture-turn", "reply"] }),
    });
    expect(exactBoundary.classification).toBe("healthy");

    resetPromptCacheDiagnosticsForTests();
    setPromptCacheDiagnosticSinkForTests((_sessionId, record) => records.push(record));
    complete({ nowMs: 3_000, read: 30_000, creation: 0 });
    const smallDrop = complete({
      nowMs: 4_000,
      read: 28_001,
      body: requestBody({ messages: ["first-fixture-turn", "reply"] }),
    });
    expect(smallDrop.classification).toBe("healthy");
  });

  it("explains changes to system, tools, model, and the message prefix", () => {
    const cases: Array<{
      reason: string;
      nextBody: Record<string, unknown>;
      nextContext?: RequestContext;
    }> = [
      {
        reason: "system_changed",
        nextBody: requestBody({ system: "changed-system-fixture" }),
      },
      {
        reason: "tools_changed",
        nextBody: requestBody({ toolDescription: "changed-tool-fixture" }),
      },
      {
        reason: "model_changed",
        nextBody: requestBody({ model: "fixture-model-b" }),
        nextContext: context({ model: "fixture-model-b" }),
      },
      {
        reason: "message_prefix_rewritten",
        nextBody: requestBody({ messages: ["replacement-summary-fixture"] }),
      },
    ];

    for (const testCase of cases) {
      resetPromptCacheDiagnosticsForTests();
      setPromptCacheDiagnosticSinkForTests((_sessionId, record) => records.push(record));
      establishAnthropicBaseline();
      const explained = complete({
        nowMs: 2_000,
        read: 0,
        creation: 26_000,
        body: testCase.nextBody,
        ...(testCase.nextContext === undefined ? {} : { ctx: testCase.nextContext }),
      });
      expect(explained.classification).toBe("explained_break");
      expect(explained.reasonCodes).toContain(testCase.reason);
    }
  });

  it("explains a stable-prefix miss after the one-hour TTL", () => {
    establishAnthropicBaseline();
    const expired = complete({
      nowMs: 1_000 + 60 * 60 * 1_000 + 1,
      read: 0,
      creation: 26_000,
      body: requestBody({ messages: ["first-fixture-turn", "reply"] }),
    });

    expect(expired.classification).toBe("explained_break");
    expect(expired.reasonCodes).toContain("cache_ttl_expired");
  });

  it("excludes refusals and resumed attempts without replacing the baseline", () => {
    establishAnthropicBaseline();
    const refusal = complete({
      nowMs: 2_000,
      read: 0,
      creation: 26_000,
      stopReason: "refusal",
    });
    const resumed = complete({
      nowMs: 3_000,
      read: 0,
      creation: 26_000,
      resumed: true,
      attempt: 2,
    });
    const healthy = complete({
      nowMs: 4_000,
      read: 26_000,
      body: requestBody({ messages: ["first-fixture-turn", "reply"] }),
    });

    expect(refusal.classification).toBe("excluded");
    expect(refusal.reasonCodes).toEqual(["refusal"]);
    expect(resumed.classification).toBe("excluded");
    expect(resumed.reasonCodes).toEqual(["resumed_stream"]);
    expect(healthy.classification).toBe("healthy");
    expect(healthy.comparison.previousSequence).toBe(1);
  });

  it("does not replace a healthy baseline when cache metrics are unavailable", () => {
    establishAnthropicBaseline();
    const unavailable = complete({ nowMs: 2_000 });
    const healthy = complete({
      nowMs: 3_000,
      read: 26_000,
      body: requestBody({ messages: ["first-fixture-turn", "reply", "follow-up"] }),
    });

    expect(unavailable.classification).toBe("insufficient_metrics");
    expect(healthy.classification).toBe("healthy");
    expect(healthy.comparison.previousSequence).toBe(1);
  });

  it("uses the previous read as the expected floor for read-only cache metrics", () => {
    const codex = context({ provider: "codex" as ProviderId, model: "fixture-codex" });
    complete({
      ctx: codex,
      nowMs: 1_000,
      read: 24_000,
      body: requestBody({ model: "fixture-codex" }),
    });
    const suspect = complete({
      ctx: codex,
      nowMs: 2_000,
      read: 0,
      body: requestBody({
        model: "fixture-codex",
        messages: ["first-fixture-turn", "reply", "follow-up"],
      }),
    });

    expect(suspect.classification).toBe("suspected_break");
    expect(suspect.comparison.expectedCacheReadTokens).toBe(24_000);
  });

  it("keeps agent lineages independent", () => {
    const agentA = context({ agentId: "fixture-agent-a" });
    const agentB = context({ agentId: "fixture-agent-b" });
    complete({ ctx: agentA, nowMs: 1_000, read: 0, creation: 26_000 });
    const otherAgent = complete({ ctx: agentB, nowMs: 2_000, read: 0, creation: 0 });

    expect(otherAgent.classification).toBe("baseline");
  });

  it("logs opaque request evidence without prompt, credential, or path content", () => {
    const privatePrompt = "fixture-private-prompt-value";
    const privateCredential = "fixture-secret-token-value";
    const privatePath = "/workspace/private-owner-path";
    const record = complete({
      ctx: context({ cwd: privatePath }),
      body: requestBody({ messages: [privatePrompt], secret: privateCredential }),
      nowMs: 1_000,
      read: 0,
      creation: 26_000,
    });
    const serialized = JSON.stringify(record);

    expect(serialized).not.toContain(privatePrompt);
    expect(serialized).not.toContain(privateCredential);
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain(privatePath);
    expect(record.response.requestId).toBe("req-1000");
    expect(record.response.messageId).toBe("msg-1000");
    expect(record.request.toolNames).toEqual(["Read", "mcp"]);
    expect(record.reasonCodes).toEqual(["first_comparable_request"]);
  });
});
