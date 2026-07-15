import { describe, expect, test } from "bun:test";
import type { Provider } from "@/engine/contract/types.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import * as providers from "@/engine/providers/registry.ts";
import { runTurn } from "@/engine/queue/runtime/turn/loop.ts";
import type { TurnLoopHost } from "@/engine/queue/runtime/turn/types.ts";
import { activePlanFilePath } from "@/engine/tools/plan-gate.ts";
import { makeQueue } from "@/harness/composer/queue.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";

registerAllProviders();

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// First provider response is silent (no text, no tool calls) — this drives
// the loop's own empty-response recovery into a second continuation
// (turn > 0), which is where the mid-turn permission-mode reminder check
// lives. The mode is flipped to "default" as that first response lands, so
// the second continuation observes a plan -> non-plan transition.
function makeProvider(onFirstCallLanded: () => void): Provider {
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
        onFirstCallLanded();
      } else {
        yield { kind: "text_delta", text: "done" };
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
  mode: { current: "plan" | "default" },
  messages: { role: "user"; content: ContentBlock[] }[],
): TurnLoopHost {
  return {
    cancelled: false,
    currentTurnId: null,
    activeAbortController: null,
    activeToolAbortControllers: new Set(),
    injections: makeQueue(),
    deps: {
      session: {
        id: "plan-exit-reminder-session",
        cwd: process.cwd(),
        messages,
        records: [],
      } as never,
      broker: {
        read: () => ({
          provider: "xai",
          model: "grok-4.5",
          effort: null,
          permissionMode: mode.current,
          ultracode: false,
        }),
      } as never,
      config: { defaultProvider: "xai", defaultModel: "grok-4.5" } as never,
    },
    compactState: {
      circuitOpen: false,
      rapidRefillBreakerOpen: false,
      rapidRefillCount: 0,
      turnsSinceLast: Number.POSITIVE_INFINITY,
      consecutiveFailures: 0,
    },
    sessionAllowedToolPatterns: new Set(),
    loadedNestedMemoryPaths: new Set(),
    nestedMemoryByPath: new Map(),
    pendingUserInputDrainer: () => [],
    cancel: () => {},
    getNestedMemorySnapshot: () => [],
  };
}

function flatText(messages: { role: "user"; content: ContentBlock[] }[]): string {
  return messages
    .map((m) => m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n"))
    .join("\n---\n");
}

describe("runTurn mid-turn plan-exit reminder", () => {
  test("fires the exited-plan-mode reminder exactly once when mode flips from plan to non-plan mid-turn", async () => {
    const mode: { current: "plan" | "default" } = { current: "plan" };
    providers.register(
      makeProvider(() => {
        mode.current = "default";
      }),
    );
    const messages: { role: "user"; content: ContentBlock[] }[] = [];
    const host = makeHost(mode, messages);

    const events: string[] = [];
    for await (const event of runTurn(host, "hello")) events.push(event.kind);

    expect(events).toContain("silent_turn_end_recovery");
    expect(events).toContain("turn_end");

    const texts = flatText(messages);
    // The initial enter-plan reminder still rides the first user message and
    // names the sole Write target available while planning.
    expect(texts).toContain(
      "Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits",
    );
    expect(texts).toContain("## Plan File Info:");
    expect(texts).toContain(
      "NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.",
    );
    expect(texts).toContain(activePlanFilePath("plan-exit-reminder-session"));
    // The new exit reminder, exact model-facing text, fires exactly once.
    const exitReminder =
      "## Exited Plan Mode\n\nYou have exited plan mode. You can now make edits, run tools, and take actions.";
    expect(texts).toContain(`<system-reminder>\n${exitReminder}\n</system-reminder>`);
    expect(texts.split("## Exited Plan Mode").length - 1).toBe(1);
  });

  test("does not fire the exit reminder when the mode never leaves plan", async () => {
    const mode: { current: "plan" | "default" } = { current: "plan" };
    providers.register(makeProvider(() => {}));
    const messages: { role: "user"; content: ContentBlock[] }[] = [];
    const host = makeHost(mode, messages);

    const events: string[] = [];
    for await (const event of runTurn(host, "hello")) events.push(event.kind);

    expect(events).toContain("silent_turn_end_recovery");
    expect(flatText(messages)).not.toContain("Exited Plan Mode");
  });
});
