import { beforeAll, describe, expect, test } from "bun:test";
import { composeAnthropicMessages } from "@/engine/providers/anthropic/compose.ts";
import { registerAllBuiltins } from "@/engine/tools/register-builtins.ts";

beforeAll(() => {
  registerAllBuiltins();
});

import {
  appendTaskReminderMessage,
  buildTaskReminderInjection,
} from "@/engine/session/task-reminder.ts";
import type { ComposedHarness } from "@/harness/composer/injections.ts";
import type { CacheControl, ContentBlock, Message } from "@/kernel/std/types/message.ts";

const SENTINEL = "The task tools haven't been used recently.";
const TASK_UPDATE_TOOLS = [{ name: "TaskUpdate" }];

function assistantText(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantTaskUse(): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "TaskUpdate", input: {} }],
  };
}

function userText(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function plainAssistantTurns(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => assistantText(`step ${i}`));
}

function emptyHarness(): ComposedHarness {
  return { layers: [], combined: "", systemBlocks: [], userPrepend: [], midSystemPromotion: "off" };
}

function cacheControlOf(block: ContentBlock | undefined): CacheControl | undefined {
  if (!block) return undefined;
  if (block.type === "text" || block.type === "tool_result") return block.cache_control;
  return undefined;
}

function lastCacheAnchorText(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") continue;
    for (const block of msg.content) {
      if (block.type === "text" && cacheControlOf(block)) return block.text;
    }
  }
  return undefined;
}

function findTextBlock(messages: Message[], text: string): ContentBlock | undefined {
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "text" && block.text === text) return block;
    }
  }
  return undefined;
}

describe("buildTaskReminderInjection — history-scanning throttle", () => {
  test("fires after 10 idle assistant turns with no prior reminder", () => {
    const messages = [userText("start"), ...plainAssistantTurns(10)];
    const reminder = buildTaskReminderInjection({
      messages,
      effectiveTools: TASK_UPDATE_TOOLS,
    });
    expect(reminder).not.toBeNull();
    expect(reminder ?? "").toContain(SENTINEL);
  });

  test("does not fire before 10 idle assistant turns", () => {
    const messages = [userText("start"), ...plainAssistantTurns(9)];
    expect(
      buildTaskReminderInjection({
        messages,
        effectiveTools: TASK_UPDATE_TOOLS,
      }),
    ).toBeNull();
  });

  test("recent TaskUpdate use suppresses the reminder", () => {
    const messages = [
      userText("start"),
      ...plainAssistantTurns(5),
      assistantTaskUse(),
      ...plainAssistantTurns(4),
    ];
    expect(
      buildTaskReminderInjection({
        messages,
        effectiveTools: TASK_UPDATE_TOOLS,
      }),
    ).toBeNull();
  });

  test("suppresses when TaskUpdate is absent from the effective toolset", () => {
    const messages = [userText("start"), ...plainAssistantTurns(10)];
    expect(
      buildTaskReminderInjection({
        messages,
        effectiveTools: [{ name: "Read" }],
      }),
    ).toBeNull();
  });

  test("user text quoting the reminder sentence does not suppress it", () => {
    const messages = [userText(`quoted: ${SENTINEL}`), ...plainAssistantTurns(10)];
    expect(
      buildTaskReminderInjection({
        messages,
        effectiveTools: TASK_UPDATE_TOOLS,
      }),
    ).not.toBeNull();
  });

  test("a persisted reminder in history suppresses re-firing next turn", () => {
    const messages = [userText("start"), ...plainAssistantTurns(10)];
    const reminder = buildTaskReminderInjection({
      messages,
      effectiveTools: TASK_UPDATE_TOOLS,
    });
    expect(reminder).not.toBeNull();

    // Persist it exactly as the runtime does, then re-evaluate immediately.
    appendTaskReminderMessage(messages, reminder ?? "");
    expect(
      buildTaskReminderInjection({
        messages,
        effectiveTools: TASK_UPDATE_TOOLS,
      }),
    ).toBeNull();

    // Still suppressed while fewer than 10 assistant turns have elapsed since it.
    messages.push(...plainAssistantTurns(9));
    expect(
      buildTaskReminderInjection({
        messages,
        effectiveTools: TASK_UPDATE_TOOLS,
      }),
    ).toBeNull();

    // Re-fires only after the throttle window of assistant turns passes.
    messages.push(...plainAssistantTurns(1));
    expect(
      buildTaskReminderInjection({
        messages,
        effectiveTools: TASK_UPDATE_TOOLS,
      }),
    ).not.toBeNull();
  });
});

describe("appendTaskReminderMessage — persistence shape", () => {
  test("appends to the trailing user message (no consecutive user turns)", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] },
    ];
    appendTaskReminderMessage(messages, "<system-reminder>\nR\n</system-reminder>");
    expect(messages).toHaveLength(1);
    const last = messages[0];
    expect(last?.content).toHaveLength(2);
    expect(last?.content[1]).toMatchObject({
      type: "text",
      text: "<system-reminder>\nR\n</system-reminder>",
    });
    expect((last?.content[1] as unknown as { reminder_type?: string }).reminder_type).toBe(
      "task_reminder",
    );
  });

  test("pushes a new user message when history ends on an assistant turn", () => {
    const messages: Message[] = [assistantText("done")];
    appendTaskReminderMessage(messages, "R");
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "R" }],
    });
    expect((messages[1]?.content[0] as unknown as { reminder_type?: string }).reminder_type).toBe(
      "task_reminder",
    );
  });
});

describe("persisted reminder keeps the cache breakpoint stable across turns", () => {
  test("reminder anchors the breakpoint the turn it lands, then survives verbatim as the anchor advances", () => {
    const reminder = buildTaskReminderInjection({
      messages: [userText("start"), ...plainAssistantTurns(10)],
      effectiveTools: TASK_UPDATE_TOOLS,
    });
    expect(reminder).not.toBeNull();
    const reminderText = reminder ?? "";

    // Turn N: the freshly persisted reminder is the trailing user block, so the
    // cache breakpoint (cache_control) anchors on it.
    const historyTurnN: Message[] = [
      userText("hi"),
      assistantText("working"),
      userText(reminderText),
    ];
    const composedN = composeAnthropicMessages(emptyHarness(), historyTurnN);
    expect(lastCacheAnchorText(composedN)).toBe(reminderText);

    // Turn N+1: an assistant reply plus a new user turn arrive after the reminder.
    // The reminder must NOT vanish (that was the cache-poisoning bug) — it stays in
    // history verbatim while the breakpoint moves forward to the new trailing block.
    const historyTurnN1: Message[] = [
      ...historyTurnN,
      assistantText("more"),
      userText("next question"),
    ];
    const composedN1 = composeAnthropicMessages(emptyHarness(), historyTurnN1);

    // Anchor advanced to the new trailing content.
    expect(lastCacheAnchorText(composedN1)).toBe("next question");

    // The reminder is still present, byte-identical, and no longer carrying the
    // breakpoint — so the cached prefix ending at it stays valid instead of being
    // invalidated by the reminder disappearing.
    const persistedReminderBlock = findTextBlock(composedN1, reminderText);
    expect(persistedReminderBlock).toBeDefined();
    expect(cacheControlOf(persistedReminderBlock)).toBeUndefined();
  });
});
