import { describe, expect, test } from "bun:test";
import { accountFingerprint } from "@/engine/providers/_shared/account-identity.ts";
import { translateRequestGrok } from "@/engine/providers/xai/translate.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

function ctx(over: Partial<RequestContext> = {}): RequestContext {
  return {
    provider: "xai",
    model: "grok-4.5",
    effort: "high",
    permissionMode: "default",
    sessionId: "replay-gate",
    cwd: "/tmp",
    ...over,
  } as RequestContext;
}

function conversationWith(assistant: Partial<Message>): Message[] {
  const account = accountFingerprint("xai");
  return [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      producedBy: "xai",
      producedModel: "grok-4.5",
      ...(account ? { producedAccount: account } : {}),
      content: [
        { type: "thinking", text: "prior reasoning", signature: "ENC-BLOB" },
        { type: "text", text: "ok" },
      ],
      ...assistant,
    },
    { role: "user", content: [{ type: "text", text: "next" }] },
  ];
}

function reasoningItemsOnWire(messages: Message[]): number {
  const body = translateRequestGrok(ctx(), messages, []) as {
    input: Array<Record<string, unknown>>;
  };
  return body.input.filter((i) => i.type === "reasoning").length;
}

describe("grok encrypted reasoning replay gate", () => {
  test("replays reasoning produced by xai under the same model and account", () => {
    expect(reasoningItemsOnWire(conversationWith({}))).toBe(1);
  });

  test("drops reasoning produced by another provider, even with a matching model stamp", () => {
    expect(reasoningItemsOnWire(conversationWith({ producedBy: "anthropic" }))).toBe(0);
    expect(reasoningItemsOnWire(conversationWith({ producedBy: "codex" }))).toBe(0);
  });

  test("drops unstamped (legacy) reasoning because provenance cannot be proven", () => {
    const messages = conversationWith({});
    const assistant = messages[1] as Message & { producedBy?: string };
    delete assistant.producedBy;
    expect(reasoningItemsOnWire(messages)).toBe(0);
  });

  test("drops reasoning stamped by another account", () => {
    expect(reasoningItemsOnWire(conversationWith({ producedAccount: "other-account" }))).toBe(0);
  });

  test("drops reasoning produced by another model", () => {
    expect(reasoningItemsOnWire(conversationWith({ producedModel: "grok-4" }))).toBe(0);
  });

  test("keeps the assistant text and tool calls when its reasoning drops", () => {
    const messages = conversationWith({ producedBy: "anthropic" });
    const body = translateRequestGrok(ctx(), messages, []) as {
      input: Array<Record<string, unknown>>;
    };
    expect(body.input.some((i) => i.type === "message" && i.role === "assistant")).toBe(true);
    expect(body.input.some((i) => i.type === "reasoning")).toBe(false);
  });
});
