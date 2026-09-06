import { describe, expect, it } from "bun:test";
import { commitAssistantMessage } from "@/engine/queue/runtime/turn/assistant-commit.ts";
import { TurnAttempt } from "@/engine/queue/runtime/turn/attempt.ts";
import type { AgentDeps } from "@/engine/queue/runtime/turn/types.ts";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";

const SIGNATURE = "G".repeat(420);

function depsWithBroker(
  provider: string,
  model: string,
  session: { messages: Message[] },
): AgentDeps {
  return {
    broker: { read: () => ({ provider, model }) },
    session,
  } as unknown as AgentDeps;
}

function thinkingBlock(session: {
  messages: Message[];
}): Extract<ContentBlock, { type: "thinking" }> | undefined {
  const content = session.messages[0]?.content;
  const blocks = Array.isArray(content) ? content : [];
  return blocks.find(
    (b): b is Extract<ContentBlock, { type: "thinking" }> => b.type === "thinking",
  );
}

function attemptWith(fields: Partial<TurnAttempt>): TurnAttempt {
  return Object.assign(new TurnAttempt(), fields);
}

describe("commitAssistantMessage thinking provenance", () => {
  it("stamps the producing route, not the switched-to broker provider", () => {
    // The broker already switched to anthropic mid-turn, but this turn's
    // reasoning was produced by xai/grok. The stamp must follow the producer,
    // or the grok signature later replays onto the anthropic wire as a 400.
    const session = { messages: [] as Message[] };
    commitAssistantMessage(
      depsWithBroker("anthropic", "claude-opus-4-8", session),
      attemptWith({
        text: "answer",
        thinking: "grok reasoning",
        thinkingSignature: SIGNATURE,
        producedProvider: "xai",
        producedModel: "grok-4.5",
      }),
    );
    const thinking = thinkingBlock(session);
    expect(thinking?.producedBy).toBe("xai");
    expect(thinking?.producedModel).toBe("grok-4.5");
  });

  it("falls back to the live broker route when no producer is given", () => {
    const session = { messages: [] as Message[] };
    commitAssistantMessage(
      depsWithBroker("anthropic", "claude-opus-4-8", session),
      attemptWith({ text: "answer", thinking: "reasoning", thinkingSignature: "A".repeat(420) }),
    );
    const thinking = thinkingBlock(session);
    expect(thinking?.producedBy).toBe("anthropic");
    expect(thinking?.producedModel).toBe("claude-opus-4-8");
  });
});

describe("a restarted attempt carries nothing forward", () => {
  it("clears every field the commit reads", () => {
    const attempt = attemptWith({
      text: "partial",
      thinking: "partial reasoning",
      thinkingSignature: SIGNATURE,
      toolCalls: [{ id: "t1", name: "Read", input: {} }],
      stopReason: "tool_calls",
      refusalExplanation: "no",
      messageId: "m1",
      requestId: "r1",
      producedProvider: "xai",
      producedModel: "grok-4.5",
      charCapTripped: true,
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 4,
      },
      providerError: "boom",
    });
    attempt.restart();
    expect(attempt).toEqual(new TurnAttempt());

    // A restarted attempt has nothing to commit, so the re-send starts clean.
    const session = { messages: [] as Message[] };
    commitAssistantMessage(depsWithBroker("anthropic", "claude-opus-4-8", session), attempt);
    expect(session.messages).toEqual([]);
  });
});
