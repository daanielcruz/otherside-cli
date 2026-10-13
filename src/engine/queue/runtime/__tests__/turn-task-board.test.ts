import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDLE_TASK_TURNS } from "@/engine/background/tasks/board-turns.ts";
import { boardTurn, clearAll, create } from "@/engine/background/tasks/index.ts";
import { setTaskOutputSession } from "@/engine/background/tasks/output-files.ts";
import type { Provider } from "@/engine/contract/types.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import * as providers from "@/engine/providers/registry.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import { runTurn } from "@/engine/queue/runtime/turn/loop.ts";
import type { TurnLoopHost } from "@/engine/queue/runtime/turn/types.ts";
import { makeQueue } from "@/harness/composer/queue.ts";
import type { Message } from "@/kernel/std/types/message.ts";

registerAllProviders();

const SESSION = "turn-task-board-session";
let root: string;
let savedConfigDir: string | undefined;
let previousProvider: Provider;

function makeHost(cwd: string, messages: Message[]): TurnLoopHost {
  return {
    cancelled: false,
    currentTurnId: null,
    activeAbortController: null,
    activeToolAbortControllers: new Set(),
    injections: makeQueue(),
    deps: {
      session: { id: SESSION, cwd, messages, records: [] } as never,
      broker: {
        read: () => ({
          provider: "codex",
          model: "<model>",
          effort: null,
          permissionMode: "default",
          ultracode: false,
        }),
        dispatch: () => {},
      } as never,
      config: { defaultProvider: "codex", defaultModel: "<model>", memoryRecall: false } as never,
    },
    compactState: {} as never,
    sessionAllowedToolPatterns: new Set(),
    loadedNestedMemoryPaths: new Set(),
    nestedMemoryByPath: new Map(),
    pendingUserInputDrainer: () => [],
    cancel: () => {},
    getNestedMemorySnapshot: () => [],
  };
}

async function drain(host: TurnLoopHost, input: string): Promise<void> {
  for await (const _event of runTurn(host, input)) {
    // drained for its effects on the session and the board
  }
}

function reminderTexts(messages: readonly Message[]): string[] {
  return messages.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((block) =>
          block.type === "text" && block.text.includes("These open tasks have not changed")
            ? [block.text]
            : [],
        )
      : [],
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turn-task-board-"));
  savedConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  process.env.OTHERSIDE_CONFIG_DIR = join(root, "config");
  clearAll();
  setTaskOutputSession({ sessionId: SESSION, cwd: root });
  previousProvider = providers.get("codex");
  providers.register({
    ...previousProvider,
    startStreamAttempt: () => ({
      events: (async function* () {
        yield { kind: "message_start" } as const;
        yield { kind: "text_delta", text: "<reply>" } as const;
        yield { kind: "message_stop", stop_reason: "stop" } as const;
      })(),
      abort: () => {},
    }),
  });
});

afterEach(() => {
  providers.register(previousProvider);
  emitQueue._resetForTests();
  clearAll();
  if (savedConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = savedConfigDir;
  rmSync(root, { recursive: true, force: true });
});

describe("a user turn and the task board", () => {
  it("counts only turns the user started", async () => {
    const messages: Message[] = [];
    const host = makeHost(root, messages);
    await drain(host, "first request");
    await drain(host, "");
    await drain(host, "second request");
    expect(boardTurn()).toBe(2);
  });

  it("names an idle open task to the model in the turn it went idle", async () => {
    create({ subject: "Finish the list", description: "" });
    const messages: Message[] = [];
    const host = makeHost(root, messages);
    for (let turn = 1; turn < IDLE_TASK_TURNS; turn++) await drain(host, `request ${turn}`);
    expect(reminderTexts(messages)).toEqual([]);
    await drain(host, "one more request");
    const [reminder] = reminderTexts(messages);
    expect(reminder).toContain("#1 [pending] Finish the list");
    expect(reminder).toStartWith("<system-reminder>");
  });
});
