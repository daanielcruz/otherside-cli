import { afterAll, describe, expect, it, mock } from "bun:test";
import * as dispatchModule from "@/commands/dispatch.ts";
import type { SlashResult } from "@/commands/types.ts";
import { TurnGuard } from "@/engine/queue/runtime/turn/guard.ts";
import { createHandleSlash } from "@/ui/app/dispatch/slash.ts";
import type { DispatchLoopDeps } from "@/ui/app/dispatch/types.ts";

// slash.ts calls the real `dispatch` (aliased slashDispatch) directly from this
// module, not via injected deps — mock.module is the only way to control it and
// keep the compact run pending across an await so the guard state can be
// observed mid-flight. `lookup`/`looksLikeCommand` stay real: "compact" already
// resolves from the static catalog with no async work.
let mockDispatchImpl: typeof dispatchModule.dispatch = dispatchModule.dispatch;
mock.module("@/commands/dispatch.ts", () => ({
  ...dispatchModule,
  dispatch: (...args: Parameters<typeof dispatchModule.dispatch>) => mockDispatchImpl(...args),
}));

afterAll(() => {
  mock.module("@/commands/dispatch.ts", () => dispatchModule);
});

function makeDeps(turnGuard: TurnGuard, pushQueued: (text: string) => void) {
  return {
    session: { id: "s1", cwd: "/tmp", eventSeq: 0, messages: [] },
    broker: { read: () => ({ provider: "anthropic", model: "claude-sonnet-5" }) },
    agent: {},
    version: "test",
    exit: () => {},
    runtimeConfig: {},
    mainLastContext: {},
    turnGuard,
    turnLifecycle: { beginTurn: () => {}, endTurn: () => {} },
    clearTranscript: () => {},
    applySlashResult: async () => {},
    enterBtwMode: () => {},
    slashLifecycle: { onSessionFinalize: () => {} },
    setTranscript: () => {},
    setMainTokenTotals: () => {},
    setMainLastContext: () => {},
    setProgressInputTokens: () => {},
    setProgressStartedAt: () => {},
    setConfigInitialTab: () => {},
    setLoginInitialProvider: () => {},
    showErrorPanel: () => {},
    pushQueued,
  } as unknown as DispatchLoopDeps;
}

describe("handleSlash(/compact) holds the TurnGuard for its whole run", () => {
  it("begins the guard synchronously, rejects a concurrent claim, and settles on completion", async () => {
    let resolveDispatch: (result: SlashResult) => void = () => {};
    mockDispatchImpl = () =>
      new Promise((resolve) => {
        resolveDispatch = resolve;
      });

    const turnGuard = new TurnGuard();
    const pushed: string[] = [];
    const deps = makeDeps(turnGuard, (text) => pushed.push(text));
    const handleSlash = createHandleSlash(deps, () => {});

    const handled = handleSlash("/compact");

    expect(handled).toBe(true);
    // begin() runs synchronously before the async dispatch IIFE starts, so the
    // guard is already "running" the instant handleSlash returns.
    expect(turnGuard.active).toBe(true);
    expect(turnGuard.claim()).toBe(false); // a concurrent dispatch loses the race
    expect(pushed).toEqual([]);

    resolveDispatch({ kind: "instant", feedback: "compacted" });
    // Let the pending microtasks (the finally + applySlashResult await) drain.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(turnGuard.active).toBe(false); // settle() ran and returned the guard to idle
  });

  it("queues the compact instead of racing a live turn when begin() returns null", () => {
    const turnGuard = new TurnGuard();
    turnGuard.begin(); // a real turn is already running
    let dispatchCalls = 0;
    mockDispatchImpl = (async () => {
      dispatchCalls += 1;
      return { kind: "instant" } as SlashResult;
    }) as typeof dispatchModule.dispatch;

    const pushed: string[] = [];
    const deps = makeDeps(turnGuard, (text) => pushed.push(text));
    const handleSlash = createHandleSlash(deps, () => {});

    const handled = handleSlash("/compact");

    expect(handled).toBe(true);
    expect(pushed).toEqual(["/compact"]);
    expect(dispatchCalls).toBe(0); // never entered the async dispatch path
  });
});
