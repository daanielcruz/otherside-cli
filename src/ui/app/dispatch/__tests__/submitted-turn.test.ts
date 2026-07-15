import { describe, expect, it } from "bun:test";
import { TurnGuard } from "@/engine/queue/runtime/turn/guard.ts";
import { createRunSubmittedTurn } from "@/ui/app/dispatch/submitted-turn.ts";
import type { DispatchLoopDeps } from "@/ui/app/dispatch/types.ts";

// Everything past the guard check is unreachable when claim() fails, so the rest
// of DispatchLoopDeps only needs to satisfy the type — none of it is exercised.
function makeDeps(turnGuard: TurnGuard, flushDeferredPersistence: () => Promise<void>) {
  return {
    session: { id: "s1", cwd: "/tmp" },
    broker: { read: () => ({}) },
    agent: { injections: { peek: () => [] }, setPendingUserInputDrainer: () => {} },
    runtimeConfig: {},
    transcript: [],
    mainLastContext: {},
    btwMode: false,
    turnGuard,
    turnLifecycle: { beginTurn: () => {}, endTurn: () => {} },
    recordProviderUsage: () => {},
    pendingInputDrainer: () => [],
    postTurnDrain: () => ({ nextText: null, nextSuppress: false, nextRestoreEntryId: undefined }),
    agentBlockText: () => "",
    setAgentNested: () => {},
    setAgentBackgrounded: () => {},
    beginThinkingStatus: () => {},
    endThinkingStatus: () => {},
    resetThinkingStatus: () => {},
    setTranscript: () => {},
    setStreamingId: () => {},
    setStreamingText: () => {},
    setStreamingThinking: () => {},
    setStreamingCommittedLen: () => {},
    setCodexUsage: () => {},
    setMainTokenTotals: () => {},
    setMainLastContext: () => {},
    setProgressInputTokens: () => {},
    setProgressStartedAt: () => {},
    setTasksExpanded: () => {},
    setContextWarningSuppressed: () => {},
    setConfigInitialTab: () => {},
    setLoginInitialProvider: () => {},
    showErrorPanel: () => {},
    handleQuotaExhausted: () => {},
    showUnsupportedImageInput: () => {},
    flushDeferredPersistence,
    clearExitPending: () => {},
    promptHistoryIndexRef: { current: null },
    pasteStoreRef: { current: { get: () => undefined } },
  } as unknown as DispatchLoopDeps;
}

describe("runSubmittedTurn guard enforcement (D1)", () => {
  it("dispatches nothing when the guard is already claimed (running)", async () => {
    const turnGuard = new TurnGuard();
    turnGuard.begin(); // simulate a turn already in flight
    let flushed = false;
    const deps = makeDeps(turnGuard, async () => {
      flushed = true;
    });
    const runSubmittedTurn = createRunSubmittedTurn(deps, {
      handleSlash: () => false,
      requestBackgroundResume: () => {},
    });

    await runSubmittedTurn("hello");

    // Never got past the guard check — no side effect ran, and the guard state
    // (owned by the other turn) is untouched.
    expect(flushed).toBe(false);
    expect(turnGuard.active).toBe(true);
  });

  it("proceeds past the guard check when idle (claim succeeds)", async () => {
    const turnGuard = new TurnGuard();
    let flushed = false;
    const deps = makeDeps(turnGuard, async () => {
      flushed = true;
    });
    const runSubmittedTurn = createRunSubmittedTurn(deps, {
      handleSlash: () => false,
      requestBackgroundResume: () => {},
    });

    // Reaching flushDeferredPersistence proves claim() let the dispatch through;
    // the guard is now in "dispatching", mirroring a real caller's claim ahead
    // of begin(). An empty-text (resume) call keeps the rest of the deep dispatch
    // machinery out of scope for this test.
    await runSubmittedTurn("");

    expect(flushed).toBe(true);
  });
});
