import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@/engine/contract/types.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import * as providers from "@/engine/providers/registry.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import {
  USER_REJECTED_TOOL_RESULT,
  USER_REJECTED_WITH_FEEDBACK_PREFIX,
} from "@/engine/queue/runtime/rejection-text.ts";
import { runTurn } from "@/engine/queue/runtime/turn/loop.ts";
import type { TurnLoopHost } from "@/engine/queue/runtime/turn/types.ts";
import { makeQueue } from "@/harness/composer/queue.ts";
import {
  answer as answerPermission,
  clear as clearPermissionQueue,
  subscribe as subscribePermission,
} from "@/kernel/channels/permission.ts";
import type { AgentEvent } from "@/kernel/std/types/events.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";

registerAllProviders();

type SessionMessage = { role: "user" | "assistant"; content: ContentBlock[] };

function makeHost(cwd: string, messages: SessionMessage[], queued: string[]): TurnLoopHost {
  return {
    cancelled: false,
    currentTurnId: null,
    activeAbortController: null,
    activeToolAbortControllers: new Set(),
    injections: makeQueue(),
    deps: {
      session: { id: "rejection-session", cwd, messages, records: [] } as never,
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
    pendingUserInputDrainer: () =>
      queued.splice(0).map((text) => ({ text, blocks: [{ type: "text", text }] })),
    cancel: () => {},
    getNestedMemorySnapshot: () => [],
  };
}

/** A model that writes one file, then answers in text once it hears back. */
function writingProvider(target: string, requests: string[]): Provider {
  return {
    ...providers.get("codex"),
    id: "codex",
    startStreamAttempt: (_ctx, body) => {
      requests.push(JSON.stringify(body));
      const call = requests.length;
      return {
        events: (async function* () {
          yield { kind: "message_start", id: `msg-${call}` };
          if (call === 1) {
            yield {
              kind: "tool_call_complete",
              id: "call-write",
              name: "Write",
              input: { file_path: target, content: "<content>" },
            };
          } else {
            yield { kind: "text_delta", text: "<reply>" };
          }
          yield { kind: "message_stop", stop_reason: call === 1 ? "tool_calls" : "stop" };
        })(),
        abort: () => {},
      };
    },
  };
}

function toolResultText(messages: SessionMessage[]): string | undefined {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_result" && typeof block.content === "string") return block.content;
    }
  }
  return undefined;
}

/** Runs one turn whose Write prompt the user answers with a rejection. */
async function runRejectedTurn(feedback: string | undefined, queued: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "turn-rejection-"));
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  const previousConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  process.env.OTHERSIDE_CONFIG_DIR = join(root, "config");
  const target = join(cwd, "<file>.txt");
  const requests: string[] = [];
  const messages: SessionMessage[] = [];
  const host = makeHost(cwd, messages, queued);
  const previousProvider = providers.get("codex");
  const stopped: { result: string | undefined; rootAborted: boolean }[] = [];
  providers.register({
    ...writingProvider(target, requests),
    onToolTurnStopped: async (ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(ctx.sessionId).toBe("rejection-session");
      stopped.push({
        result: toolResultText(messages),
        rootAborted: host.activeAbortController?.signal.aborted === true,
      });
    },
  });
  const unsubscribe = subscribePermission((queue) => {
    const pending = queue[0];
    if (pending) {
      answerPermission(pending.id, {
        decision: "deny",
        updates: [],
        ...(feedback ? { feedback } : {}),
      });
    }
  });
  const spawnSync = Bun.spawnSync;
  Bun.spawnSync = (() => ({ stdout: new Uint8Array(), exitCode: 1 })) as never;
  let written = false;
  try {
    for await (const _event of runTurn(host, "<request>")) {
      // drained for its side effects on the session
    }
    written = existsSync(target);
  } finally {
    Bun.spawnSync = spawnSync;
    providers.register(previousProvider);
    unsubscribe();
    clearPermissionQueue();
    if (previousConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = previousConfigDir;
    rmSync(root, { recursive: true, force: true });
  }
  return { requests, messages, written, stopped };
}

describe("a refused provider request", () => {
  it("preserves the explanation without offering a retry or sending another request", async () => {
    const root = mkdtempSync(join(tmpdir(), "turn-refusal-"));
    const previousConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    const previousProvider = providers.get("codex");
    process.env.OTHERSIDE_CONFIG_DIR = join(root, "config");
    const refusal = "The service refused this request. Details: [reasoning_extraction].";
    let attempts = 0;
    providers.register({
      ...previousProvider,
      startStreamAttempt: () => {
        attempts += 1;
        return {
          events: (async function* () {
            yield { kind: "message_start" } as const;
            yield { kind: "text_delta", text: refusal } as const;
            yield { kind: "message_stop", stop_reason: "refusal", refusal } as const;
          })(),
          abort: () => {},
        };
      },
    });
    const events: AgentEvent[] = [];
    try {
      for await (const event of runTurn(makeHost(root, [], []), "A request")) events.push(event);
      expect(attempts).toBe(1);
      expect(events.find((event) => event.kind === "error")).toMatchObject({
        error: refusal,
        meta: {
          title: "Request refused",
          summary: refusal,
          retryable: false,
          actions: [{ id: "cancel", label: "Cancel" }],
        },
      });
    } finally {
      providers.register(previousProvider);
      emitQueue._resetForTests();
      if (previousConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
      else process.env.OTHERSIDE_CONFIG_DIR = previousConfigDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a call the user rejects at its prompt", () => {
  afterEach(() => {
    emitQueue._resetForTests();
  });

  it("ends the turn without asking the model to go on", async () => {
    const { requests, messages, written, stopped } = await runRejectedTurn(undefined);

    expect(written).toBe(false);
    expect(toolResultText(messages)).toBe(USER_REJECTED_TOOL_RESULT);
    expect(requests).toHaveLength(1);
    expect(stopped).toEqual([{ result: USER_REJECTED_TOOL_RESULT, rootAborted: false }]);
  });

  it("leaves messages typed meanwhile queued for the next turn", async () => {
    const queued = ["<queued>"];
    const { requests } = await runRejectedTurn(undefined, queued);

    expect(requests).toHaveLength(1);
    expect(queued).toEqual(["<queued>"]);
  });

  it("hands the user's directions to the model and lets the turn go on", async () => {
    const { requests, messages, stopped } = await runRejectedTurn("<directions>");

    expect(toolResultText(messages)).toBe(`${USER_REJECTED_WITH_FEEDBACK_PREFIX}<directions>`);
    expect(requests).toHaveLength(2);
    expect(stopped).toEqual([]);
  });
});
