import { describe, expect, it } from "bun:test";
import { fingerprint } from "@/engine/providers/anthropic/_infra/fingerprint.ts";
import { translateRequestAnthropic } from "@/engine/providers/anthropic/translate.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
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
  const body = translateRequestAnthropic(ctx, MESSAGES, TOOLS) as Record<string, unknown>;
  const print = fingerprint(ctx);
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
  {
    label: "haiku / title (non-agentic, structured)",
    ctx: context({ model: "claude-haiku-4-5", agentic: false, cacheRole: "title" }),
  },
  {
    label: "opus / sub-agent (suppressThinkingSummary → bare adaptive, no display)",
    ctx: context({ suppressThinkingSummary: true }),
  },
];

describe("anthropic wire-fact golden (gates model registry #1)", () => {
  for (const { label, ctx } of MATRIX) {
    it(label, () => {
      expect(wireFacts(ctx)).toMatchSnapshot();
    });
  }
});
