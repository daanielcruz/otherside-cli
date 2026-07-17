import { describe, expect, it } from "bun:test";
import { accountFingerprint } from "@/engine/providers/_shared/account-identity.ts";
import { buildAnthropicMessages } from "@/engine/providers/anthropic/translate.ts";
import { translateRequestGrok } from "@/engine/providers/xai/translate.ts";
import type { AssistantMessageRecord, SessionRecord } from "@/engine/session/record/index.ts";
import { sessionRecordsToMessages } from "@/engine/session/transcript/to-messages.ts";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

// Both signatures are base64-shaped and long enough to pass any wire shape
// check, so the assertions below prove the provenance gate (not a shape
// gate) is what keeps each blob on its own provider.
const GROK_SIGNATURE = "G".repeat(420);
const ANTHROPIC_SIGNATURE = "A".repeat(420);

function assistantRecord(over: Partial<AssistantMessageRecord>): AssistantMessageRecord {
  return {
    type: "assistant_message",
    ts: "2026-07-16T12:00:00.000Z",
    content: "",
    ...over,
  };
}

// Two assistant records from different providers with no user record between
// them: the rebuild fuses them into ONE assistant message whose message-level
// stamp can only describe the later producer.
function mixedSessionRecords(): SessionRecord[] {
  return [
    {
      type: "user_message",
      ts: "2026-07-16T11:59:00.000Z",
      content: "hi",
    } as SessionRecord,
    assistantRecord({
      content: "grok answer",
      thinking: "grok reasoning",
      thinkingSignature: GROK_SIGNATURE,
      provider: "xai",
      model: "grok-4.5",
      ...(accountFingerprint("xai") ? { producedAccount: accountFingerprint("xai") } : {}),
    }),
    assistantRecord({
      content: "anthropic answer",
      thinking: "anthropic reasoning",
      thinkingSignature: ANTHROPIC_SIGNATURE,
      provider: "anthropic",
      model: "claude-fable-5",
      ...(accountFingerprint("anthropic")
        ? { producedAccount: accountFingerprint("anthropic") }
        : {}),
    }),
    {
      type: "user_message",
      ts: "2026-07-16T12:01:00.000Z",
      content: "next",
    } as SessionRecord,
  ];
}

function anthropicCtx(): RequestContext {
  return {
    provider: "anthropic",
    model: "claude-fable-5",
    effort: "high",
    permissionMode: "default",
    sessionId: "mixed",
    cwd: "/tmp",
  } as RequestContext;
}

function grokCtx(): RequestContext {
  return {
    provider: "xai",
    model: "grok-4.5",
    effort: "high",
    permissionMode: "default",
    sessionId: "mixed",
    cwd: "/tmp",
  } as RequestContext;
}

describe("mixed-provider session rebuild", () => {
  it("fuses adjacent assistant records while each thinking block keeps its own stamp", () => {
    const messages = sessionRecordsToMessages(mixedSessionRecords());
    const assistants = messages.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(1);
    const thinkings = (assistants[0]?.content ?? []).filter(
      (b): b is Extract<ContentBlock, { type: "thinking" }> => b.type === "thinking",
    );
    expect(thinkings.map((b) => b.producedBy)).toEqual(["xai", "anthropic"]);
  });

  it("never ships the grok blob to the anthropic wire after fusion", () => {
    const messages = sessionRecordsToMessages(mixedSessionRecords());
    const wire = buildAnthropicMessages(messages, anthropicCtx())
      .out.flatMap((m) => m.content)
      .filter((b) => b.type === "thinking");
    expect(wire.length).toBe(1);
    expect(wire[0]?.signature).toBe(ANTHROPIC_SIGNATURE);
  });

  it("replays only the grok blob on the grok wire after fusion", () => {
    const messages = sessionRecordsToMessages(mixedSessionRecords());
    const body = translateRequestGrok(grokCtx(), messages, []) as {
      input: Array<Record<string, unknown>>;
    };
    const reasoning = body.input.filter((i) => i.type === "reasoning");
    expect(reasoning.length).toBe(1);
    expect(reasoning[0]?.encrypted_content).toBe(GROK_SIGNATURE);
  });
});

describe("per-block provenance on a fused message", () => {
  function fusedMessage(): Message[] {
    return [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        // Message-level stamp describes the LAST producer only — exactly what
        // a rebuild merge leaves behind.
        producedBy: "anthropic",
        producedModel: "claude-fable-5",
        ...(accountFingerprint("anthropic")
          ? { producedAccount: accountFingerprint("anthropic") }
          : {}),
        content: [
          {
            type: "thinking",
            text: "grok reasoning",
            signature: GROK_SIGNATURE,
            producedBy: "xai",
            producedModel: "grok-4.5",
            ...(accountFingerprint("xai") ? { producedAccount: accountFingerprint("xai") } : {}),
          },
          {
            type: "thinking",
            text: "anthropic reasoning",
            signature: ANTHROPIC_SIGNATURE,
            producedBy: "anthropic",
            producedModel: "claude-fable-5",
            ...(accountFingerprint("anthropic")
              ? { producedAccount: accountFingerprint("anthropic") }
              : {}),
          },
          { type: "text", text: "ok" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ];
  }

  it("anthropic wire keeps only the anthropic-stamped block", () => {
    const wire = buildAnthropicMessages(fusedMessage(), anthropicCtx())
      .out.flatMap((m) => m.content)
      .filter((b) => b.type === "thinking");
    expect(wire.length).toBe(1);
    expect(wire[0]?.signature).toBe(ANTHROPIC_SIGNATURE);
  });

  it("grok wire keeps only the xai-stamped block even when the message stamp says anthropic", () => {
    const body = translateRequestGrok(grokCtx(), fusedMessage(), []) as {
      input: Array<Record<string, unknown>>;
    };
    const reasoning = body.input.filter((i) => i.type === "reasoning");
    expect(reasoning.length).toBe(1);
    expect(reasoning[0]?.encrypted_content).toBe(GROK_SIGNATURE);
  });

  it("legacy unstamped blocks still fall back to the message stamp", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        producedBy: "anthropic",
        producedModel: "claude-fable-5",
        ...(accountFingerprint("anthropic")
          ? { producedAccount: accountFingerprint("anthropic") }
          : {}),
        content: [
          { type: "thinking", text: "legacy reasoning", signature: ANTHROPIC_SIGNATURE },
          { type: "text", text: "ok" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ];
    const wire = buildAnthropicMessages(messages, anthropicCtx())
      .out.flatMap((m) => m.content)
      .filter((b) => b.type === "thinking");
    expect(wire.length).toBe(1);
  });
});
