import { describe, expect, test } from "bun:test";
import { accountFingerprint } from "@/engine/providers/_shared/account-identity.ts";
import { streamErrorToHttpError } from "@/engine/providers/_shared/retry.ts";
import { config } from "@/engine/providers/xai/config.ts";
import { translateRequestGrok } from "@/engine/providers/xai/translate.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

function ctx(sessionId: string): RequestContext {
  return {
    provider: "xai",
    model: "grok-4.5",
    effort: "high",
    permissionMode: "default",
    sessionId,
    cwd: "/tmp",
  } as RequestContext;
}

function reasoningMessages(): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      producedModel: "grok-4.5",
      producedAccount: accountFingerprint("xai"),
      content: [
        { type: "thinking", text: "prior reasoning", signature: "ENC-STALE-BLOB" },
        { type: "text", text: "done" },
      ],
    } as Message,
  ];
}

// The real xAI rejection shares codex's Responses shape.
function verificationError() {
  return streamErrorToHttpError({
    provider: "xai/responses",
    rawBody: JSON.stringify({
      error: {
        type: "invalid_request_error",
        message:
          "The encrypted content ENC...== could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
      },
    }),
  });
}

describe("grok encrypted_content rejection recovery", () => {
  test("replays encrypted_content until rejected, then drops it and retries once", () => {
    const c = ctx("grok-enc-reject-1");
    const msgs = reasoningMessages();

    const before = translateRequestGrok(c, msgs, []) as { input: Array<Record<string, unknown>> };
    expect(before.input.find((i) => i.type === "reasoning")?.encrypted_content).toBe(
      "ENC-STALE-BLOB",
    );

    const first = config.recoverableError?.(verificationError(), c, 1);
    expect(first?.kind).toBe("retry");

    const after = translateRequestGrok(c, msgs, []) as { input: Array<Record<string, unknown>> };
    expect(after.input.find((i) => i.type === "reasoning")).toBeUndefined();

    const second = config.recoverableError?.(verificationError(), c, 2);
    expect(second?.kind).not.toBe("retry");
  });

  test("recognizes the active-voice proxy wording for a broken blob", () => {
    const c = ctx("grok-enc-reject-3");
    const activeVoiceError = streamErrorToHttpError({
      provider: "xai/responses",
      rawBody: JSON.stringify({
        code: "invalid-argument",
        error:
          "Could not decrypt the provided encrypted_content. Ensure the value is the unmodified encrypted_content from a previous response.",
      }),
    });
    const first = config.recoverableError?.(activeVoiceError, c, 1);
    expect(first?.kind).toBe("retry");
    expect(first?.reason).toBe("dropped stale encrypted reasoning");
  });

  test("does NOT treat a plain reasoning-param 400 as an encrypted-reasoning rejection", () => {
    const c = ctx("grok-enc-reject-2");
    const paramError = streamErrorToHttpError({
      provider: "xai/responses",
      rawBody: JSON.stringify({
        code: "invalid-argument",
        error: "This model does not support `reasoning_effort` value `none`.",
      }),
    });
    const result = config.recoverableError?.(paramError, c, 1);
    // Must not fire the drop-and-retry path (would wrongly suppress reasoning).
    expect(result?.reason).not.toBe("dropped stale encrypted reasoning");
  });
});
