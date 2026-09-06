import { describe, expect, it } from "bun:test";
import {
  nextPeelAdvance,
  peelAdvanceForGap,
  scrubCarriedAssistantUsage,
} from "@/engine/session/compact/peel.ts";
import type { Message } from "@/kernel/std/types/message.ts";

describe("reactive compact peel", () => {
  it("uses one group when the provider does not report a token gap", () => {
    expect(nextPeelAdvance(undefined, [10, 20, 30], 3)).toBe(1);
  });

  it("accumulates full-list group tokens backward from the summary boundary", () => {
    const groupTokens = [500, 1, 1000, 7, 90];
    expect(peelAdvanceForGap(groupTokens, 4, 7)).toBe(1);
    expect(peelAdvanceForGap(groupTokens, 4, 8)).toBe(2);
  });

  it("treats zero and negative gaps as a one-group advance", () => {
    expect(peelAdvanceForGap([10, 20, 30, 40], 4, 0)).toBe(1);
    expect(peelAdvanceForGap([10, 20, 30, 40], 4, -1)).toBe(1);
  });

  it("halves when the gap would leave at most one summary group", () => {
    expect(peelAdvanceForGap([10, 20, 30, 40], 4, 70)).toBe(2);
    expect(peelAdvanceForGap([10, 20, 30, 40], 4, 71)).toBe(2);
    expect(peelAdvanceForGap([10, 20, 30, 40], 4, 1_000_000)).toBe(2);
    expect(peelAdvanceForGap([], 0, 1)).toBe(1);
    expect(peelAdvanceForGap([10], 1, 1)).toBe(1);
    expect(peelAdvanceForGap([10, 20], 2, 1)).toBe(1);
  });
});

describe("carried assistant usage", () => {
  it("returns messages without assistant usage by identity", () => {
    const assistant: Message = {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
    };
    const user = {
      role: "user",
      content: [{ type: "text", text: "question" }],
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        thoughtTokens: 3,
        cacheCreationInputTokens: 4,
        cacheReadInputTokens: 5,
      },
    } as Message;
    expect(scrubCarriedAssistantUsage(assistant)).toBe(assistant);
    expect(scrubCarriedAssistantUsage(user)).toBe(user);
  });

  it("clones assistant usage and zeroes exactly the accounting counters", () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 20,
      thoughtTokens: 30,
      cacheCreationInputTokens: 40,
      cacheReadInputTokens: 50,
      retainedUsageField: 60,
    };
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      usage,
      retainedMessageField: { stable: true },
    } as Message & {
      retainedMessageField: { stable: boolean };
      usage: Message["usage"] & { retainedUsageField: number };
    };

    const scrubbed = scrubCarriedAssistantUsage(message) as typeof message;
    expect(scrubbed).not.toBe(message);
    expect(scrubbed.usage).not.toBe(usage);
    expect(scrubbed).toEqual({
      ...message,
      usage: {
        ...usage,
        inputTokens: 0,
        outputTokens: 0,
        thoughtTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    });
    expect(message.usage).toBe(usage);
    expect(message.usage.inputTokens).toBe(10);
  });

  it("adds the complete zero shape to partial assistant usage", () => {
    const message = {
      role: "assistant",
      content: [],
      usage: { inputTokens: 8, outputTokens: 9 },
    } as unknown as Message;
    expect(scrubCarriedAssistantUsage(message).usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      thoughtTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });
});
