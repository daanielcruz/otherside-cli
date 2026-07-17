import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountFingerprint } from "@/engine/providers/_shared/account-identity.ts";
import { buildAnthropicMessages } from "@/engine/providers/anthropic/translate.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

// The deepseek wire reuses the anthropic message builder; the env key below
// pins the current account fingerprint so stamped-vs-foreign cases are stable.
const ENV_KEY = "OTHERSIDE_DEEPSEEK_API_KEY";

let scratchDir: string;
let priorConfigDir: string | undefined;
let priorApiKey: string | undefined;

beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "deepseek-gate-"));
  priorConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  priorApiKey = process.env[ENV_KEY];
  process.env.OTHERSIDE_CONFIG_DIR = scratchDir;
  process.env[ENV_KEY] = "deepseek-test-key";
});

afterAll(() => {
  if (priorConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = priorConfigDir;
  if (priorApiKey === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = priorApiKey;
  rmSync(scratchDir, { recursive: true, force: true });
});

const ctx = {
  provider: "deepseek",
  model: "deepseek-v4-pro",
  effort: "high",
  permissionMode: "default",
  sessionId: "deepseek-gate",
  cwd: "/tmp",
} as unknown as RequestContext;

function conversationWith(assistant: Partial<Message>): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      producedBy: "deepseek",
      producedModel: "deepseek-v4-pro",
      producedAccount: accountFingerprint("deepseek"),
      content: [
        { type: "thinking", text: "prior reasoning", signature: "ds-sig-bytes" },
        { type: "text", text: "ok" },
      ],
      ...assistant,
    },
    { role: "user", content: [{ type: "text", text: "next" }] },
  ];
}

function wireThinkingBlocks(messages: Message[]): Array<Record<string, unknown>> {
  return buildAnthropicMessages(messages, ctx)
    .out.flatMap((m) => m.content)
    .filter((b) => b.type === "thinking");
}

describe("deepseek signed thinking replay gate", () => {
  it("replays thinking produced by deepseek under the same account", () => {
    const blocks = wireThinkingBlocks(conversationWith({}));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.signature).toBe("ds-sig-bytes");
  });

  it("drops thinking produced by another provider, even when signed", () => {
    expect(wireThinkingBlocks(conversationWith({ producedBy: "anthropic" }))).toHaveLength(0);
    expect(wireThinkingBlocks(conversationWith({ producedBy: "xai" }))).toHaveLength(0);
  });

  it("drops thinking stamped by another account", () => {
    expect(wireThinkingBlocks(conversationWith({ producedAccount: "other" }))).toHaveLength(0);
  });

  it("never fabricates an empty signature for an unsigned block", () => {
    const messages = conversationWith({});
    const assistant = messages[1];
    if (assistant) {
      assistant.content = [
        { type: "thinking", text: "unsigned reasoning" },
        { type: "text", text: "ok" },
      ];
    }
    expect(wireThinkingBlocks(messages)).toHaveLength(0);
  });

  it("keeps the assistant text when its thinking drops", () => {
    const { out } = buildAnthropicMessages(conversationWith({ producedBy: "anthropic" }), ctx);
    const assistant = out.find((m) => m.role === "assistant");
    expect(assistant?.content.some((b) => b.type === "text")).toBe(true);
    expect(assistant?.content.some((b) => b.type === "thinking")).toBe(false);
  });
});
