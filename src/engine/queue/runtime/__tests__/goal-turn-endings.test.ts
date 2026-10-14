import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@/engine/contract/types.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import * as providers from "@/engine/providers/registry.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import { _resetGoalInterruptionsForTesting } from "@/engine/queue/runtime/goal-after-turn.ts";
import { evaluateGoal } from "@/engine/queue/runtime/goal-evaluation.ts";
import { makeRequestContext } from "@/engine/queue/runtime/request-context.ts";
import { runTurn } from "@/engine/queue/runtime/turn/loop.ts";
import type { TurnLoopHost } from "@/engine/queue/runtime/turn/types.ts";
import { _resetGoalsForTesting, getActiveGoal, setActiveGoal } from "@/engine/queue/state.ts";
import { setRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import { ProviderHttpError } from "@/kernel/std/types/error-meta.ts";
import type { AgentEvent } from "@/kernel/std/types/events.ts";
import { scriptedProvider, turnEvents, turnHost } from "./turn-fixture.ts";

const SESSION_ID = "session-1";
const CONDITION = "all tests pass";

const rejected = (): ProviderHttpError =>
  new ProviderHttpError({
    provider: "xai",
    status: 413,
    body: '{"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
  });

/** The turn's events, also when the turn ends by throwing its failure. */
async function settledTurnEvents(host: TurnLoopHost, input = "continue"): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  try {
    for await (const event of runTurn(host, input)) events.push(event);
  } catch {
    // The failure itself is shown by the caller; the goal's reaction is what is checked.
  }
  return events;
}

function noticeTexts(events: readonly AgentEvent[]): string[] {
  return events.flatMap((event) => (event.kind === "turn_notice" ? [event.text] : []));
}

beforeEach(() => {
  registerAllProviders();
  setRuntimeKind("interactive");
  _resetGoalsForTesting();
  _resetGoalInterruptionsForTesting();
  emitQueue._resetForTests();
  setActiveGoal(SESSION_ID, CONDITION);
});

afterEach(() => {
  setRuntimeKind(null);
  _resetGoalsForTesting();
  _resetGoalInterruptionsForTesting();
  emitQueue._resetForTests();
  registerAllProviders();
});

describe("a goal check without a verdict", () => {
  test("ends the turn and schedules a retry instead of continuing", async () => {
    const fake = scriptedProvider(["Working on it.", "this is not a verdict"]);
    providers.register(fake.provider);

    const events = await turnEvents(turnHost(SESSION_ID));

    expect(fake.calls()).toBe(2);
    expect(events.some((event) => event.kind === "goal_continue")).toBe(false);
    expect(events.some((event) => event.kind === "error")).toBe(false);
    expect(noticeTexts(events)).toEqual([
      "Goal still active · the goal check could not complete · retrying in 1 min (1/3) · send a message to retry now",
    ]);
    expect(getActiveGoal(SESSION_ID)?.condition).toBe(CONDITION);
  });

  test("times out into a pause when the check never answers", async () => {
    const silent: Provider = {
      ...providers.get("xai"),
      id: "xai",
      startStreamAttempt: (ctx) => ({
        events: (async function* () {
          await new Promise<void>((resolve) => {
            ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new Error("aborted");
        })(),
        abort: () => {},
      }),
    };
    providers.register(silent);
    const host = turnHost(SESSION_ID);
    const generator = evaluateGoal({
      session: host.deps.session,
      config: host.deps.config,
      ctx: makeRequestContext(host.deps),
      cancelled: () => false,
      timeoutMs: 20,
    });
    let result = await generator.next();
    while (result.done !== true) result = await generator.next();

    expect(result.value?.outcome).toBe("timed_out");
  });
});

describe("a Stop hook after it blocked the turn", () => {
  test("is told the stop hook is active, so it can let the turn end", async () => {
    _resetGoalsForTesting();
    const dir = mkdtempSync(join(tmpdir(), "stop-hook-active-"));
    const script = join(dir, "gate.ts");
    writeFileSync(
      script,
      "const input = await Bun.stdin.text();\nprocess.exit(input.includes('\"stop_hook_active\":true') ? 0 : 2);\n",
    );
    const fake = scriptedProvider(["First pass.", "Second pass."]);
    providers.register(fake.provider);
    const host = turnHost(SESSION_ID);
    host.deps.config = {
      ...host.deps.config,
      hooks: { stop: [{ type: "command", command: `"${process.execPath}" "${script}"` }] },
    } as never;
    try {
      await turnEvents(host);
      expect(fake.calls()).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a request the provider rejects", () => {
  test("pauses the goal once, and again only after the user writes", async () => {
    providers.register(scriptedProvider([rejected(), rejected(), rejected(), rejected()]).provider);
    const host = turnHost(SESSION_ID);
    const PAUSED =
      "Goal paused · the API rejected the last request · send a message to continue, or run /goal clear";

    expect(noticeTexts(await settledTurnEvents(host))).toEqual([PAUSED]);
    // A turn the session starts on its own is not the user writing.
    expect(noticeTexts(await settledTurnEvents(host, ""))).toEqual([]);
    expect(noticeTexts(await settledTurnEvents(host, "try again"))).toEqual([PAUSED]);
    expect(getActiveGoal(SESSION_ID)?.condition).toBe(CONDITION);
  });
});
