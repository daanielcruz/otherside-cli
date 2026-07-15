import { describe, expect, it } from "bun:test";
import { computeUsedContextTokens } from "@/engine/queue/runtime/compact/support.ts";
import { estimateHarnessTokens } from "@/engine/session/compact/harness-baseline.ts";
import type { UsageSnapshot } from "@/engine/session/compact/token-count.ts";
import type { Message } from "@/kernel/std/types/message.ts";

const PROVIDER = "anthropic" as const;
const MODEL = "claude-opus-4-8";

function usage(inputTokens: number): UsageSnapshot {
  return {
    inputTokens,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

describe("computeUsedContextTokens — fork usage anchoring", () => {
  it("anchors on real usage and does not add the harness baseline on top", () => {
    // A fork assistant message carries no per-message .usage; the fork threads
    // its last server usage explicitly. That count already includes the system
    // prompt the server counted, so the harness baseline must not be re-added.
    const messages: Message[] = [{ role: "assistant", content: [{ type: "text", text: "done" }] }];
    const used = computeUsedContextTokens(messages, usage(50_000), PROVIDER, MODEL);
    expect(used).toBe(50_000);
    expect(used).toBeLessThan(50_000 + estimateHarnessTokens(PROVIDER, MODEL));
  });

  it("adds only the estimated tail appended after the last assistant", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(30) }],
      },
    ];
    // tool_result body of 30 chars at 3 bytes/token = 10, anchored on 50_000.
    const used = computeUsedContextTokens(messages, usage(50_000), PROVIDER, MODEL);
    expect(used).toBe(50_010);
  });

  it("falls back to rough estimate plus harness when no usage is available", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "x".repeat(400) }] },
    ];
    const used = computeUsedContextTokens(messages, null, PROVIDER, MODEL);
    expect(used).toBe(100 + estimateHarnessTokens(PROVIDER, MODEL));
  });
});
