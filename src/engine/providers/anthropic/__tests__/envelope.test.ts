import { describe, expect, it } from "bun:test";
import { knowledgeCutoffFor } from "@/engine/model/facts/knowledge-cutoff.ts";
import {
  fingerprint,
  REDACT_THINKING_BETA,
} from "@/engine/providers/anthropic/_infra/fingerprint.ts";
import {
  anthropicEnvelopeDefaults,
  applyAnthropicThinkingDisplay,
  maxOutputTokensForModel,
} from "@/engine/providers/anthropic/envelope.ts";
import { translateRequestAnthropic } from "@/engine/providers/anthropic/translate.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

registerAllProviders();

const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    provider: "anthropic",
    model: "claude-opus-5",
    effort: null,
    permissionMode: "default",
    sessionId: "thinking-summary-test",
    cwd: "/tmp",
    agentic: true,
    ...overrides,
  };
}

describe("Anthropic model envelope", () => {
  it("uses the 64K default output limit for Opus 5", () => {
    expect(maxOutputTokensForModel("claude-opus-5")).toBe(64_000);
    expect(maxOutputTokensForModel("claude-opus-5[1m]")).toBe(64_000);
  });

  it("defaults adaptive thinking to the visible summarized envelope", () => {
    expect(anthropicEnvelopeDefaults().thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
  });

  it("can omit the display field without changing the adaptive envelope", () => {
    const body = anthropicEnvelopeDefaults();
    applyAnthropicThinkingDisplay(body, "omitted");
    expect(body.thinking).toEqual({ type: "adaptive" });
  });
});

describe("Anthropic thinking-summary gate", () => {
  it("sends summarized thinking and omits the redact beta by default", () => {
    const ctx = context();
    const body = translateRequestAnthropic(ctx, messages, []) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(fingerprint(ctx, body).betaHeaders).not.toContain(REDACT_THINKING_BETA);
  });

  it("sends bare adaptive thinking and the redact beta when summaries are hidden", () => {
    const ctx = context({ showThinkingSummaries: false });
    const body = translateRequestAnthropic(ctx, messages, []) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(fingerprint(ctx, body).betaHeaders).toContain(REDACT_THINKING_BETA);
  });
});

describe("Anthropic request class and thinking binding", () => {
  function classOf(overrides: Partial<RequestContext>): string | undefined {
    return fingerprint(context(overrides)).extraHeaders?.["x-claude-code-request-class"];
  }

  it("names each kind of request by what it is doing", () => {
    expect(classOf({})).toBe("main");
    expect(classOf({ agentOwnerId: "agent-1" })).toBe("subagent");
    expect(classOf({ isForkChild: true })).toBe("subagent");
    expect(classOf({ isCompaction: true })).toBe("compaction");
    expect(classOf({ agentic: false })).toBe("auxiliary");
    expect(classOf({ cacheRole: "side-question" })).toBe("auxiliary");
  });

  it("opts into thinking binding only when the request reasons", () => {
    const binding = "thinking-binding-controls-2026-08-01";
    const betas = (body: unknown, overrides: Partial<RequestContext> = {}) =>
      fingerprint(context(overrides), body).betaHeaders;
    expect(betas({ thinking: { type: "adaptive" } })).toContain(binding);
    expect(betas({ thinking: { type: "enabled", budget_tokens: 1024 } })).toContain(binding);
    expect(betas({ thinking: { type: "disabled" } })).not.toContain(binding);
    expect(betas({})).not.toContain(binding);
    expect(betas({ thinking: { type: "adaptive" } }, { disableThinking: true })).not.toContain(
      binding,
    );
  });
});

describe("Anthropic point-release model facts", () => {
  it("gives Opus 5.5 the 128K default output limit, apart from Opus 5", () => {
    expect(maxOutputTokensForModel("claude-opus-5-5")).toBe(128_000);
    expect(maxOutputTokensForModel("claude-opus-5-5[1m]")).toBe(128_000);
    expect(maxOutputTokensForModel("claude-opus-5")).toBe(64_000);
  });

  it("resolves a point release's cutoff before its family's", () => {
    expect(knowledgeCutoffFor("claude-opus-5-5")).toBe("June 2026");
    expect(knowledgeCutoffFor("claude-opus-5")).toBe("May 2026");
    expect(knowledgeCutoffFor("claude-fable-5-1")).toBe("June 2026");
    expect(knowledgeCutoffFor("claude-fable-5")).toBe("January 2026");
  });
});
