import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Provider } from "@/engine/contract/types.ts";
import { registerRuntimeModel, resetRuntimeModelsForTests } from "@/engine/model/catalog.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import * as providers from "@/engine/providers/registry.ts";
import { runTurn } from "@/engine/queue/runtime/turn/loop.ts";
import type { TurnLoopHost } from "@/engine/queue/runtime/turn/types.ts";
import { makeQueue } from "@/harness/composer/queue.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";

registerAllProviders();

const savedDisableCompact = process.env.OTHERSIDE_DISABLE_COMPACT;
const savedDisableAutoCompact = process.env.OTHERSIDE_DISABLE_AUTO_COMPACT;

beforeEach(() => {
  delete process.env.OTHERSIDE_DISABLE_COMPACT;
  delete process.env.OTHERSIDE_DISABLE_AUTO_COMPACT;
});

afterEach(() => {
  resetRuntimeModelsForTests();
  restoreEnv("OTHERSIDE_DISABLE_COMPACT", savedDisableCompact);
  restoreEnv("OTHERSIDE_DISABLE_AUTO_COMPACT", savedDisableAutoCompact);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function makeProvider(firstUsage = { inputTokens: 447_000, outputTokens: 84_603 }): Provider {
  let calls = 0;
  return {
    ...providers.get("xai"),
    id: "xai",
    stream: async function* () {
      calls += 1;
      yield encoder.encode(String(calls));
    },
    translateResponse: async function* (raw) {
      let call = "";
      for await (const chunk of raw) call += decoder.decode(chunk);
      yield { kind: "message_start", id: `msg-${call}` };
      if (call === "1") {
        yield { kind: "text_delta", text: "done" };
        yield {
          kind: "usage",
          inputTokens: firstUsage.inputTokens,
          outputTokens: firstUsage.outputTokens,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        };
      } else {
        yield {
          kind: "text_delta",
          text: "Summary: enough compacted session detail to pass the validity check and keep work resumable.",
        };
        yield {
          kind: "usage",
          inputTokens: 1_000,
          outputTokens: 100,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        };
      }
      yield { kind: "message_stop", stop_reason: "stop" };
    },
  };
}

function makeHost(
  messages: { role: "user"; content: ContentBlock[] }[] = [],
  model = "grok-4.5",
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
          provider: "xai",
          model,
          effort: null,
          permissionMode: "default",
          ultracode: false,
        }),
      } as never,
      config: { defaultProvider: "xai", defaultModel: model } as never,
    },
    compactState: {
      rapidRefillBreakerOpen: false,
      rapidRefillCount: 0,
      consecutiveCompactFailures: 0,
      turnsSinceLast: Number.POSITIVE_INFINITY,
      lastAutoCompactAttemptTurnId: null,
    },
    sessionAllowedToolPatterns: new Set(),
    loadedNestedMemoryPaths: new Set(),
    nestedMemoryByPath: new Map(),
    pendingUserInputDrainer: () => [],
    cancel: () => {},
    getNestedMemorySnapshot: () => [],
  };
}

describe("runTurn post-response compaction", () => {
  test("runs auto-compact before returning idle when the response crosses the threshold", async () => {
    providers.register(makeProvider());
    const host = makeHost();
    const events = [];

    for await (const event of runTurn(host, "hello")) {
      events.push(event.kind);
      if (event.kind === "compact_start") break;
    }

    expect(events).toContain("turn_end");
    expect(events).toContain("compact_start");
    expect(events.indexOf("compact_start")).toBeGreaterThan(events.indexOf("turn_end"));
  });

  test("honors both automatic compaction disable knobs", async () => {
    for (const key of ["OTHERSIDE_DISABLE_COMPACT", "OTHERSIDE_DISABLE_AUTO_COMPACT"] as const) {
      process.env[key] = "1";
      providers.register(makeProvider());
      const events = [];

      for await (const event of runTurn(makeHost(), "hello")) events.push(event.kind);

      expect(events).toContain("turn_end");
      expect(events).not.toContain("compact_start");
      delete process.env[key];
    }
  });

  test("honors the automatic compaction setting", async () => {
    providers.register(makeProvider());
    const disabledHost = makeHost();
    (disabledHost.deps.config as { autoCompact?: boolean }).autoCompact = false;
    const disabledEvents = [];

    for await (const event of runTurn(disabledHost, "hello")) disabledEvents.push(event.kind);

    expect(disabledEvents).not.toContain("compact_start");
  });

  test("uses the provider-scoped model autoCompactTokenLimit", async () => {
    const model = "shared-compact-boundary";
    registerRuntimeModel({
      id: model,
      displayName: "Codex boundary",
      contextWindow: 200_000,
      autoCompactTokenLimit: 180_000,
      provider: "codex",
      efforts: ["high"],
      defaultEffort: "high",
    });
    registerRuntimeModel({
      id: model,
      displayName: "xAI boundary",
      contextWindow: 200_000,
      autoCompactTokenLimit: 120_000,
      provider: "xai",
      efforts: ["high"],
      defaultEffort: "high",
    });
    // xAI host + 140k used: model limit 120k trips compact; codex's 180k limit must not win.
    providers.register(makeProvider({ inputTokens: 140_000, outputTokens: 0 }));
    const host = makeHost([], model);
    const events = [];

    for await (const event of runTurn(host, "hello")) {
      events.push(event.kind);
      if (event.kind === "compact_start") break;
    }

    expect(events).toContain("turn_end");
    expect(events).toContain("compact_start");
  });

  test("counts separate user submissions instead of same-turn continuations", async () => {
    providers.register(makeProvider({ inputTokens: 1_000, outputTokens: 100 }));
    const host = makeHost();
    host.compactState.turnsSinceLast = 0;
    const firstEvents = [];
    const secondEvents = [];

    for await (const event of runTurn(host, "first")) firstEvents.push(event.kind);
    expect(firstEvents).toContain("turn_end");
    expect(host.compactState.turnsSinceLast).toBe(1);

    for await (const event of runTurn(host, "second")) secondEvents.push(event.kind);
    expect(secondEvents).toContain("turn_end");
    expect(host.compactState.turnsSinceLast).toBe(2);
  });
});
