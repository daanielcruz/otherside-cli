import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamErrorToHttpError } from "@/engine/providers/_shared/retry.ts";
import { config } from "@/engine/providers/anthropic/config.ts";
import { buildAnthropicMessages } from "@/engine/providers/anthropic/translate.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

// An empty config dir: no credentials file, so the current account fingerprint
// is unknown and unstamped blocks keep replaying (unknown matches unknown).
let scratchDir: string;
let priorConfigDir: string | undefined;

beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "anthropic-latch-"));
  priorConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  process.env.OTHERSIDE_CONFIG_DIR = scratchDir;
});

afterAll(() => {
  if (priorConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = priorConfigDir;
  rmSync(scratchDir, { recursive: true, force: true });
});

const SIGNATURE = "A".repeat(420);

function ctx(sessionId: string): RequestContext {
  return {
    provider: "anthropic",
    model: "claude-fable-5",
    effort: "high",
    permissionMode: "default",
    sessionId,
    cwd: "/tmp",
  } as RequestContext;
}

function thinkingConversation(): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      producedBy: "anthropic",
      producedModel: "claude-fable-5",
      content: [
        { type: "thinking", text: "prior reasoning", signature: SIGNATURE },
        { type: "text", text: "ok" },
      ],
    },
    { role: "user", content: [{ type: "text", text: "next" }] },
  ];
}

function thinkingBlocksOnWire(sessionId: string): number {
  return buildAnthropicMessages(thinkingConversation(), ctx(sessionId))
    .out.flatMap((m) => m.content)
    .filter((b) => b.type === "thinking").length;
}

function thinkingRejection(message: string) {
  return streamErrorToHttpError({
    provider: "/v1/messages",
    rawBody: JSON.stringify({
      error: { type: "invalid_request_error", message },
    }),
  });
}

describe("anthropic thinking replay rejection recovery", () => {
  it("replays thinking until rejected, then drops it and retries once", () => {
    const c = ctx("anthropic-latch-1");
    expect(thinkingBlocksOnWire(c.sessionId)).toBe(1);

    const first = config.recoverableError?.(
      thinkingRejection(
        "messages.1.content.0: `thinking` blocks in the latest assistant turn cannot be modified. thinking blocks cannot be modified",
      ),
      c,
      1,
    );
    expect(first?.kind).toBe("retry");
    expect(first?.reason).toBe("dropped stale thinking replay");

    expect(thinkingBlocksOnWire(c.sessionId)).toBe(0);

    const second = config.recoverableError?.(
      thinkingRejection("thinking blocks cannot be modified"),
      c,
      2,
    );
    expect(second?.kind).not.toBe("retry");
  });

  it("recognizes the leading-thinking-block constraint wording", () => {
    const c = ctx("anthropic-latch-2");
    const first = config.recoverableError?.(
      thinkingRejection("messages.3: the final assistant message must start with a thinking block"),
      c,
      1,
    );
    expect(first?.kind).toBe("retry");
    expect(first?.reason).toBe("dropped stale thinking replay");
  });

  it("recognizes the invalid-signature rejection from a cross-provider replay", () => {
    const c = ctx("anthropic-latch-signature");
    const first = config.recoverableError?.(
      thinkingRejection("messages.51.content.0: Invalid `signature` in `thinking` block"),
      c,
      1,
    );
    expect(first?.kind).toBe("retry");
    expect(first?.reason).toBe("dropped stale thinking replay");
  });

  it("does NOT treat an unrelated 400 as a thinking replay rejection", () => {
    const c = ctx("anthropic-latch-3");
    const result = config.recoverableError?.(
      thinkingRejection("max_tokens: must be greater than thinking.budget_tokens"),
      c,
      1,
    );
    expect(result?.reason).not.toBe("dropped stale thinking replay");
    // The session stays unlatched: thinking still replays.
    expect(thinkingBlocksOnWire(c.sessionId)).toBe(1);
  });
});
