import { describe, expect, it } from "bun:test";
import type { Provider } from "@/engine/contract/types.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import * as providers from "@/engine/providers/registry.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import { runTurn } from "@/engine/queue/runtime/turn/loop.ts";
import type { TurnLoopHost } from "@/engine/queue/runtime/turn/types.ts";
import { makeQueue } from "@/harness/composer/queue.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";

registerAllProviders();

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function makeHost(
  messages: { role: "user"; content: ContentBlock[] }[],
  pendingUserInputDrainer: TurnLoopHost["pendingUserInputDrainer"] = () => [
    {
      text: "queued user",
      blocks: [{ type: "text", text: "queued user" }],
    },
  ],
): TurnLoopHost {
  return {
    cancelled: false,
    currentTurnId: null,
    activeAbortController: null,
    activeToolAbortControllers: new Set(),
    injections: makeQueue(),
    deps: {
      session: {
        id: "s1",
        cwd: process.cwd(),
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
      config: { defaultProvider: "codex", defaultModel: "gpt-5.5", memoryRecall: false } as never,
    },
    compactState: {} as never,
    sessionAllowedToolPatterns: new Set(),
    loadedNestedMemoryPaths: new Set(),
    nestedMemoryByPath: new Map(),
    pendingUserInputDrainer,
    cancel: () => {},
    getNestedMemorySnapshot: () => [],
  };
}

function makeTextOnlyCompletionProvider(requests: string[]): Provider {
  let calls = 0;
  return {
    ...providers.get("codex"),
    id: "codex",
    stream: async function* (_ctx, body) {
      calls += 1;
      requests.push(JSON.stringify(body));
      yield encoder.encode(String(calls));
    },
    translateResponse: async function* (raw) {
      let call = "";
      for await (const chunk of raw) call += decoder.decode(chunk);
      yield { kind: "message_start", id: `msg-${call}` };
      if (call === "1") {
        yield { kind: "text_delta", text: "TEXT_ONLY_BEFORE_COMPLETION" };
        emitQueue.emitForCompletion({
          class: "deferred_output",
          ownerId: undefined,
          isSubagentOwned: false,
          payload: {
            kind: "task_notification_xml",
            text: "<task-notification>TEXT_ONLY_COMPLETION</task-notification>",
            summary: "TEXT_ONLY_COMPLETION",
          },
          replayKey: "test:text-only-completion",
        });
      } else {
        yield { kind: "text_delta", text: "TEXT_ONLY_COMPLETION_ACKNOWLEDGED" };
      }
      yield {
        kind: "usage",
        inputTokens: 1_000,
        outputTokens: 100,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      };
      yield { kind: "message_stop", stop_reason: "stop" };
    },
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

  it("re-invokes after a text-only response when a completion arrives mid-turn", async () => {
    emitQueue._resetForTests();
    const requests: string[] = [];
    providers.register(makeTextOnlyCompletionProvider(requests));
    const events: { kind: string; text?: string }[] = [];
    // The turn assembler probes git only to find project memory. Keep this
    // focused queue test independent from the test runner's process handles.
    const spawnSync = Bun.spawnSync;
    Bun.spawnSync = (() => ({
      stdout: new Uint8Array(),
      exitCode: 1,
    })) as unknown as typeof Bun.spawnSync;
    try {
      for await (const event of runTurn(
        makeHost([], () => []),
        "start text-only turn",
      )) {
        events.push(event);
      }
    } finally {
      Bun.spawnSync = spawnSync;
    }

    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("TEXT_ONLY_COMPLETION");
    expect(events.filter((event) => event.kind === "turn_start")).toHaveLength(2);
    expect(events.map((event) => event.text).filter(Boolean)).toEqual([
      "TEXT_ONLY_BEFORE_COMPLETION",
      "TEXT_ONLY_COMPLETION_ACKNOWLEDGED",
    ]);
    expect(emitQueue.peek({ class: "deferred_output" })).toHaveLength(0);
  });
});
