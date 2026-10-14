import type { Provider } from "@/engine/contract/types.ts";
import * as providers from "@/engine/providers/registry.ts";
import { runTurn } from "@/engine/queue/runtime/turn/loop.ts";
import type { TurnLoopHost } from "@/engine/queue/runtime/turn/types.ts";
import { makeQueue } from "@/harness/composer/queue.ts";
import type { AgentEvent } from "@/kernel/std/types/events.ts";

/** One provider call: a reply to stream, or an error the call throws. */
export type ScriptedCall = string | Error;

/** A provider that answers each call with the next scripted reply. */
export function scriptedProvider(script: readonly ScriptedCall[]): {
  provider: Provider;
  calls: () => number;
} {
  let calls = 0;
  const provider: Provider = {
    ...providers.get("xai"),
    id: "xai",
    startStreamAttempt: () => {
      const step = script[calls];
      calls += 1;
      if (step === undefined) throw new Error(`unexpected provider call ${calls}`);
      if (step instanceof Error) throw step;
      return {
        events: (async function* () {
          yield { kind: "message_start", id: `msg-${calls}` };
          yield { kind: "text_delta", text: step };
          yield { kind: "message_stop", stop_reason: "stop" };
        })(),
        abort: () => {},
      };
    },
  };
  return { provider, calls: () => calls };
}

export function turnHost(sessionId: string): TurnLoopHost {
  return {
    cancelled: false,
    currentTurnId: null,
    activeAbortController: null,
    activeToolAbortControllers: new Set(),
    injections: makeQueue(),
    deps: {
      session: {
        id: sessionId,
        cwd: process.cwd(),
        messages: [],
        records: [],
      } as never,
      broker: {
        read: () => ({
          provider: "xai",
          model: "grok-4.6",
          effort: null,
          permissionMode: "default",
          ultracode: false,
        }),
      } as never,
      config: { defaultProvider: "xai", defaultModel: "grok-4.6" } as never,
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

export async function turnEvents(host: TurnLoopHost, input = "continue"): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runTurn(host, input)) events.push(event);
  return events;
}
