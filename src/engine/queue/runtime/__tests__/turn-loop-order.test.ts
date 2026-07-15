import { describe, expect, it } from "bun:test";
import { emitQueue } from "@/engine/queue/emit.ts";
import { runTurn } from "@/engine/queue/runtime/turn/loop.ts";
import type { TurnLoopHost } from "@/engine/queue/runtime/turn/types.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";

function makeHost(messages: { role: "user"; content: ContentBlock[] }[]): TurnLoopHost {
  return {
    cancelled: false,
    currentTurnId: null,
    activeAbortController: null,
    activeToolAbortControllers: new Set(),
    injections: { drain: () => [] } as never,
    deps: {
      session: {
        id: "s1",
        cwd: "/tmp",
        messages,
        records: [],
      } as never,
      broker: {
        read: () => ({
          provider: "codex",
          model: "gpt-5.5",
          effort: null,
          permissionMode: "default",
          ultracode: false,
        }),
      } as never,
      config: { defaultProvider: "codex", defaultModel: "gpt-5.5" } as never,
    },
    compactState: {} as never,
    sessionAllowedToolPatterns: new Set(),
    loadedNestedMemoryPaths: new Set(),
    nestedMemoryByPath: new Map(),
    pendingUserInputDrainer: () => [
      {
        text: "queued user",
        blocks: [{ type: "text", text: "queued user" }],
      },
    ],
    cancel: () => {},
    getNestedMemorySnapshot: () => [],
  };
}

describe("turn-start background resume ordering", () => {
  it("places queued user input before parked background notifications", async () => {
    emitQueue._resetForTests();
    emitQueue.emitForCompletion({
      class: "deferred_output",
      ownerId: undefined,
      isSubagentOwned: false,
      payload: {
        kind: "task_notification_xml",
        text: "<task-notification>done</task-notification>",
        summary: "done",
      },
      replayKey: "bg:t1",
    });

    const messages: { role: "user"; content: ContentBlock[] }[] = [];
    const iterator = runTurn(makeHost(messages), "")[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.(undefined as never);

    expect(messages).toHaveLength(2);
    const firstText = messages[0]?.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    const secondText = messages[1]?.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    expect(firstText).toContain("queued user");
    expect(secondText).toContain("<task-notification>done</task-notification>");
  });
});
