import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "@/engine/providers/antigravity/config.ts";
import { translateRequestAntigravity } from "@/engine/providers/antigravity/translate.ts";
import { ProviderHttpError } from "@/kernel/std/types/error-meta.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

// An empty config dir: no credentials file, so the current account fingerprint
// is unknown and unstamped blocks keep replaying (unknown matches unknown).
let scratchDir: string;
let priorConfigDir: string | undefined;

beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "antigravity-latch-"));
  priorConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  process.env.OTHERSIDE_CONFIG_DIR = scratchDir;
});

afterAll(() => {
  if (priorConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = priorConfigDir;
  rmSync(scratchDir, { recursive: true, force: true });
});

const MODEL = "gemini-3.8-flash";
const SIGNATURE = `CAIS${"B".repeat(400)}`;
const PLACEHOLDER = "skip_thought_signature_validator";

function ctx(sessionId: string): RequestContext {
  return {
    provider: "antigravity",
    model: MODEL,
    effort: "high",
    permissionMode: "default",
    sessionId,
    cwd: "/tmp",
  } as RequestContext;
}

function signedConversation(): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      producedBy: "antigravity",
      producedModel: MODEL,
      content: [
        { type: "thinking", text: "prior reasoning", signature: SIGNATURE },
        { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/tmp/a" } },
      ],
    },
    {
      role: "tool",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }],
    },
    { role: "user", content: [{ type: "text", text: "next" }] },
  ] as Message[];
}

interface WireShape {
  thoughtTexts: string[];
  signatures: string[];
}

function wire(sessionId: string): WireShape {
  const body = translateRequestAntigravity(ctx(sessionId), signedConversation(), [], {}) as {
    contents: { parts: Record<string, unknown>[] }[];
  };
  const parts = body.contents.flatMap((content) => content.parts);
  return {
    thoughtTexts: parts.filter((p) => p.thought === true).map((p) => String(p.text ?? "")),
    signatures: parts
      .map((p) => p.thoughtSignature)
      .filter((s): s is string => typeof s === "string"),
  };
}

function rejection(message: string): ProviderHttpError {
  return new ProviderHttpError({
    provider: "antigravity",
    status: 400,
    body: JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message } }),
  });
}

describe("antigravity thought signature rejection recovery", () => {
  it("replays the stored signature until rejected, then ships only the placeholder", () => {
    const c = ctx("antigravity-latch-1");
    const before = wire(c.sessionId);
    expect(before.thoughtTexts).toEqual([]);
    expect(before.signatures).toEqual([SIGNATURE]);

    const first = config.recoverableError?.(rejection("Invalid thought signature"), c, 1);
    expect(first?.kind).toBe("retry");
    expect(first?.reason).toBe("dropped stale thought signature");

    // The rebuilt request keeps the function call signed — dropping the field
    // entirely would trip the opposite complaint — but nothing verifiable ships.
    const after = wire(c.sessionId);
    expect(after.thoughtTexts).toEqual([]);
    expect(after.signatures).toEqual([PLACEHOLDER]);

    const second = config.recoverableError?.(rejection("Invalid thought signature"), c, 2);
    expect(second?.kind).not.toBe("retry");
  });

  it("recovers from every wording of a signature it cannot verify", () => {
    for (const [index, message] of [
      "Corrupted thought signature.",
      "Thought signature is not valid.",
      "Unable to verify thought_signature in part 3",
    ].entries()) {
      const c = ctx(`antigravity-latch-wording-${index}`);
      const result = config.recoverableError?.(rejection(message), c, 1);
      expect(result?.reason).toBe("dropped stale thought signature");
      expect(wire(c.sessionId).signatures).toEqual([PLACEHOLDER]);
    }
  });

  it("does NOT latch on a missing-signature complaint", () => {
    for (const [index, message] of [
      "Function call must include a thought signature",
      "Function call is missing a thought_signature in functionCall parts.",
      "thought_signature is required for function calls",
    ].entries()) {
      const c = ctx(`antigravity-latch-2-${index}`);
      const result = config.recoverableError?.(rejection(message), c, 1);
      expect(result?.reason).not.toBe("dropped stale thought signature");
      expect(wire(c.sessionId).signatures).toEqual([SIGNATURE]);
    }
  });

  it("does NOT latch on an unrelated 400", () => {
    const c = ctx("antigravity-latch-3");
    const result = config.recoverableError?.(
      rejection("Invalid value at 'generation_config.temperature'"),
      c,
      1,
    );
    expect(result?.reason).not.toBe("dropped stale thought signature");
    expect(wire(c.sessionId).signatures).toEqual([SIGNATURE]);
  });

  it("keeps the guard scoped to the session that was rejected", () => {
    const rejected = ctx("antigravity-latch-scoped-a");
    config.recoverableError?.(rejection("Invalid thought signature"), rejected, 1);
    expect(wire(rejected.sessionId).signatures).toEqual([PLACEHOLDER]);
    expect(wire("antigravity-latch-scoped-b").signatures).toEqual([SIGNATURE]);
  });
});
