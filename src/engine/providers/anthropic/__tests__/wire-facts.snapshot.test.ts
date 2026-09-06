import { describe, expect, it } from "bun:test";
import {
  ADVANCED_TOOL_USE_BETA,
  EXTENDED_CACHE_TTL_BETA,
  FAST_MODE_BETA,
  fingerprint,
  STRUCTURED_OUTPUTS_BETA,
} from "@/engine/providers/anthropic/_infra/fingerprint.ts";
import { _resetWireLatchesForTests } from "@/engine/providers/anthropic/_infra/wire-latches.ts";
import { translateRequestAnthropic } from "@/engine/providers/anthropic/translate.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import { clampSelectionRequest } from "@/engine/queue/runtime/select.ts";
import { clampTitleRequest } from "@/engine/session/title/generate.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { MODELS } from "../config.ts";

// Wire-safe baseline (ROADMAP NOW #0). Every model-derived wire fact the model
// registry (#1) will consolidate — anthropic-beta list, wire model id, max_tokens,
// the effort/thinking/context-management envelope — is a pure function of the
// RequestContext, so this golden is deterministic offline (no mitm). Gate every
// model-fact migration on its byte-diff: a registry refactor that is truly
// behaviour-preserving leaves this snapshot untouched.

registerAllProviders();

const MESSAGES: Message[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
const TOOLS: unknown[] = [
  { name: "Bash", description: "Run a shell command.", input_schema: { type: "object" } },
  { name: "ToolSearch", description: "Find tools.", input_schema: { type: "object" } },
  {
    name: "DeferredToolPlaceholder",
    description: "Reserved deferred tool.",
    input_schema: { type: "object" },
    defer_loading: true,
  },
];

function context(overrides: Partial<RequestContext>): RequestContext {
  return {
    provider: "anthropic",
    model: "claude-opus-4-8",
    effort: null,
    permissionMode: "default",
    sessionId: "sess-fixture-00000000-0000-0000-0000-000000000000",
    cwd: "/tmp/fixture",
    agentic: true,
    ...overrides,
  };
}

function wireFacts(ctx: RequestContext): Record<string, unknown> {
  const translated = translateRequestAnthropic(ctx, MESSAGES, TOOLS);
  const body = (
    ctx.cacheRole === "title"
      ? clampTitleRequest(translated)
      : ctx.requestRole === "memory_recall"
        ? clampSelectionRequest(translated)
        : translated
  ) as Record<string, unknown>;
  const print = fingerprint(ctx, body);
  return {
    betas: print.betaHeaders,
    userAgent: print.userAgent,
    runtimeVersion: print.extraHeaders["X-Stainless-Runtime-Version"],
    model: body.model,
    maxTokens: body.max_tokens,
    thinking: body.thinking ?? null,
    outputConfig: body.output_config ?? null,
    contextManagement: body.context_management ?? null,
    hasSystem: Array.isArray(body.system),
    hasTools: Array.isArray(body.tools),
  };
}

// fastMode is intentionally absent: latchFastModeIf is sticky-latched process
// state and is covered by wire-latches.test.ts; including it here would leak the
// latch into later cases.
const MATRIX: ReadonlyArray<{ label: string; ctx: RequestContext }> = [
  ...MODELS.flatMap((model) => {
    const list: Array<{ label: string; ctx: RequestContext }> = [
      {
        label: `${model.id} / default-effort`,
        ctx: context({ model: model.id, effort: null }),
      },
      ...model.efforts.map((effort) => ({
        label: `${model.id} / effort:${effort}`,
        ctx: context({ model: model.id, effort }),
      })),
    ];
    if (model.supports1m) {
      list.push({
        label: `${model.id}[1m] / default-effort`,
        ctx: context({ model: `${model.id}[1m]`, effort: null }),
      });
    }
    return list;
  }),
  ...MODELS.map((model) => ({
    label: `${model.id} / non-agentic side query`,
    ctx: context({ model: model.id, effort: null, agentic: false }),
  })),
  {
    label: "haiku / title (non-agentic, structured)",
    ctx: context({ model: "claude-haiku-4-5", agentic: false, cacheRole: "title" }),
  },
  {
    label: "haiku / memory recall (non-agentic, extended cache)",
    ctx: context({ model: "claude-haiku-4-5", agentic: false, requestRole: "memory_recall" }),
  },
  {
    label: "opus / sub-agent (suppressThinkingSummary → bare adaptive, no display)",
    ctx: context({ suppressThinkingSummary: true, agentOwnerId: "nested-fixture" }),
  },
  {
    label: "haiku / nested agent",
    ctx: context({ model: "claude-haiku-4-5", agentOwnerId: "nested-fixture" }),
  },
];

describe("anthropic beta feature gates", () => {
  it("emits advanced tool use only with deferred tool loading", () => {
    const ctx = context({});
    const withDeferredLoading = translateRequestAnthropic(ctx, MESSAGES, TOOLS);
    const withoutDeferredLoading = translateRequestAnthropic(ctx, MESSAGES, [TOOLS[0]]);

    expect(fingerprint(ctx, withDeferredLoading).betaHeaders).toContain(ADVANCED_TOOL_USE_BETA);
    expect(fingerprint(ctx, withoutDeferredLoading).betaHeaders).not.toContain(
      ADVANCED_TOOL_USE_BETA,
    );
  });

  it("omits advanced tool use from non-agentic requests", () => {
    const ctx = context({ agentic: false });
    const body = translateRequestAnthropic(ctx, MESSAGES, TOOLS);

    expect(fingerprint(ctx, body).betaHeaders).not.toContain(ADVANCED_TOOL_USE_BETA);
  });

  it("tracks structured output on agentic requests", () => {
    const ctx = context({});
    const body = {
      ...(translateRequestAnthropic(ctx, MESSAGES, TOOLS) as Record<string, unknown>),
      output_config: { format: { type: "json_schema" } },
    };

    expect(fingerprint(ctx, body).betaHeaders).toContain(STRUCTURED_OUTPUTS_BETA);
  });

  it("scopes extended cache TTL to main and memory-recall requests", () => {
    const main = context({});
    const nested = context({ agentOwnerId: "nested-fixture" });
    const memoryRecall = context({ agentic: false, requestRole: "memory_recall" });

    expect(fingerprint(main).betaHeaders).toContain(EXTENDED_CACHE_TTL_BETA);
    expect(fingerprint(nested).betaHeaders).not.toContain(EXTENDED_CACHE_TTL_BETA);
    expect(fingerprint(memoryRecall).betaHeaders).toContain(EXTENDED_CACHE_TTL_BETA);
  });

  it("drops cache_control ttl from the body when the extended TTL beta is absent", () => {
    const cached: Message[] = [
      {
        role: "system",
        content: [
          { type: "text", text: "static", cache_control: { type: "ephemeral", ttl: "1h" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "go", cache_control: { type: "ephemeral", ttl: "1h" } }],
      },
    ];
    const collectControls = (body: unknown): unknown[] => {
      const record = body as Record<string, unknown>;
      const system = record.system as Array<Record<string, unknown>>;
      const messages = record.messages as Array<{ content: Array<Record<string, unknown>> }>;
      return [...system, ...messages.flatMap((m) => m.content)]
        .map((block) => block.cache_control)
        .filter((cc) => cc !== undefined);
    };

    const nested = collectControls(
      translateRequestAnthropic(context({ agentOwnerId: "nested-fixture" }), cached, TOOLS),
    );
    expect(nested).toEqual([{ type: "ephemeral" }, { type: "ephemeral" }]);

    const main = collectControls(translateRequestAnthropic(context({}), cached, TOOLS));
    expect(main).toEqual([
      { type: "ephemeral", ttl: "1h" },
      { type: "ephemeral", ttl: "1h" },
    ]);

    const memoryRecall = collectControls(
      translateRequestAnthropic(
        context({ agentic: false, requestRole: "memory_recall" }),
        cached,
        TOOLS,
      ),
    );
    expect(memoryRecall).toEqual([
      { type: "ephemeral", ttl: "1h" },
      { type: "ephemeral", ttl: "1h" },
    ]);
  });

  it("keeps a latched fast beta off side queries", () => {
    _resetWireLatchesForTests();
    fingerprint(context({ fastMode: true }));

    expect(fingerprint(context({ agentic: false })).betaHeaders).not.toContain(FAST_MODE_BETA);
    expect(fingerprint(context({ fastMode: false })).betaHeaders).toContain(FAST_MODE_BETA);
    _resetWireLatchesForTests();
  });
});

describe("anthropic agent lineage headers", () => {
  it("omits both agent ids on a top-level request", () => {
    const headers = fingerprint(context({})).extraHeaders;

    expect(headers["x-claude-code-agent-id"]).toBeUndefined();
    expect(headers["x-claude-code-parent-agent-id"]).toBeUndefined();
  });

  it("emits only the agent id for a subagent spawned from the main session", () => {
    const headers = fingerprint(context({ agentOwnerId: "child-owner" })).extraHeaders;

    expect(headers["x-claude-code-agent-id"]).toBeDefined();
    expect(headers["x-claude-code-parent-agent-id"]).toBeUndefined();
  });

  it("emits the parent agent id for a nested subagent, hashed like the parent's own id", () => {
    const parent = fingerprint(context({ agentOwnerId: "parent-owner" })).extraHeaders;
    const nested = fingerprint(
      context({ agentOwnerId: "child-owner", parentAgentOwnerId: "parent-owner" }),
    ).extraHeaders;

    expect(nested["x-claude-code-agent-id"]).toBeDefined();
    expect(nested["x-claude-code-parent-agent-id"]).toBe(parent["x-claude-code-agent-id"]);
    expect(nested["x-claude-code-parent-agent-id"]).not.toBe(nested["x-claude-code-agent-id"]);
  });
});

describe("anthropic wire-fact golden (gates model registry #1)", () => {
  for (const { label, ctx } of MATRIX) {
    it(label, () => {
      expect(wireFacts(ctx)).toMatchSnapshot();
    });
  }
});
