import { describe, expect, test } from "bun:test";
import { mergeResumedMessages } from "@/engine/background/subagents/resume-messages.ts";
import type { SessionRecord } from "@/engine/session/record/index.ts";
import { sessionRecordsToMessages } from "@/engine/session/transcript/to-messages.ts";
import type { Message } from "@/kernel/std/types/message.ts";

function userMessage(text: string, id?: string): Message {
  return {
    role: "user",
    content: [{ type: "text", text }],
    ...(id !== undefined ? { id } : {}),
  };
}

function occurrences(messages: Message[], text: string): number {
  return JSON.stringify(messages).split(text).length - 1;
}

describe("mergeResumedMessages", () => {
  test("keeps one steer when snapshot and transcript share its stable id", () => {
    const messages = mergeResumedMessages({
      baseMessages: [userMessage("Original directive."), userMessage("Shared steer.", "steer-1")],
      history: [
        userMessage("Original directive."),
        {
          role: "assistant",
          content: [{ type: "text", text: "Initial response." }],
        },
        userMessage("Shared steer.", "steer-1"),
      ],
      steers: [],
      prompt: "Resume prompt.",
    });

    expect(occurrences(messages, "Shared steer.")).toBe(1);
  });

  test("reconstructs a persisted steer with its stable queue id", () => {
    const records: SessionRecord[] = [
      {
        type: "user_message",
        ts: "2026-07-13T00:00:00.000Z",
        content: "Persisted steer.",
        queueId: "steer-persisted",
      },
    ];

    expect(sessionRecordsToMessages(records)).toEqual([
      userMessage("Persisted steer.", "steer-persisted"),
    ]);
  });

  test("preserves a snapshot-only steer that has not reached the transcript", () => {
    const messages = mergeResumedMessages({
      baseMessages: [
        userMessage("Original directive."),
        userMessage("Snapshot-only steer.", "steer-2"),
      ],
      history: [
        userMessage("Original directive."),
        {
          role: "assistant",
          content: [{ type: "text", text: "Initial response." }],
        },
      ],
      steers: [],
      prompt: "Resume prompt.",
    });

    expect(occurrences(messages, "Snapshot-only steer.")).toBe(1);
  });
});
