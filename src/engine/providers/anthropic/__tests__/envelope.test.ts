import { describe, expect, it } from "bun:test";
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

  it("keeps Haiku's enabled thinking envelope and betas unchanged in both modes", () => {
    const visibleCtx = context({ model: "claude-haiku-4-5", showThinkingSummaries: true });
    const hiddenCtx = context({ model: "claude-haiku-4-5", showThinkingSummaries: false });
    const visibleBody = translateRequestAnthropic(visibleCtx, messages, []) as Record<
      string,
      unknown
    >;
    const hiddenBody = translateRequestAnthropic(hiddenCtx, messages, []) as Record<
      string,
      unknown
    >;

    expect(hiddenBody.thinking).toEqual(visibleBody.thinking);
    expect(hiddenBody.thinking).toEqual({ budget_tokens: 31_999, type: "enabled" });
    expect(fingerprint(visibleCtx, visibleBody).betaHeaders).not.toContain(REDACT_THINKING_BETA);
    expect(fingerprint(hiddenCtx, hiddenBody).betaHeaders).not.toContain(REDACT_THINKING_BETA);
  });
});
