import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { emitQueue } from "@/engine/queue/emit.ts";
import { TurnGuard } from "@/engine/queue/runtime/turn/guard.ts";
import { createAutoClearDispatch } from "@/kernel/std/state/auto-clear-dispatch.ts";
import { queueActions } from "@/store/queue-store/index.ts";
import { handleSlashRef, runSubmittedTurnRef } from "@/store/turn-run/index.ts";
import { createRequestBackgroundResume } from "@/ui/app/dispatch/background-resume.ts";
import { createPostTurnDrain, type TurnContinuation } from "@/ui/app/drain/post-turn.ts";
import { completionNoticeDisposition } from "@/ui/app/hooks/use-async-completion-resume.ts";

// A scheduler that fires the timeout callback synchronously, so the test doesn't
// need to wait on real timers.
const immediateScheduler = (callback: () => void) => {
  callback();
  return () => {};
};

const noopPostTurnDrain = (): TurnContinuation => ({
  nextText: null,
  nextSuppress: false,
  nextRestoreEntryId: undefined,
});

beforeEach(() => {
  emitQueue._resetForTests();
});

afterEach(() => {
  queueActions.clear();
  handleSlashRef.current = () => false;
});

describe("completion notice consumption timing", () => {
  it("appends after a busy-session task callback loses the race to queue consumption", () => {
    const replayKey = "bg:a_race:0";

    // A notice callback that beats enqueue must not render before consumption.
    expect(completionNoticeDisposition(replayKey)).toBe("park");

    emitQueue.emitForCompletion({
      class: "deferred_output",
      ownerId: undefined,
      isSubagentOwned: false,
      payload: { kind: "task_notification_xml", text: "<task-notification/>" },
      replayKey,
    });

    expect(completionNoticeDisposition(replayKey)).toBe("park");

    emitQueue.drainForBoundary("tool_loop_end");

    expect(completionNoticeDisposition(replayKey)).toBe("append");
  });
});

describe("requestBackgroundResume gating (D2 — wake driver vs a stale gate)", () => {
  it("does not dispatch while the guard is running, even with a queued message", async () => {
    const turnGuard = new TurnGuard();
    turnGuard.begin(); // a turn is live
    let dispatched = 0;
    runSubmittedTurnRef.current = async () => {
      dispatched += 1;
    };
    const requestBackgroundResume = createRequestBackgroundResume({
      agent: { injections: { peek: () => [] } } as never,
      getBgTasksOpen: () => false,
      autoResumeDispatch: createAutoClearDispatch({ holdMs: 0, scheduler: immediateScheduler }),
      turnGuard,
      postTurnDrain: noopPostTurnDrain,
      runtimeConfig: {} as never,
      setTranscript: () => {},
    });

    requestBackgroundResume();

    // The old bug: gating on a UI `runningRef` boolean that can go stale-false
    // while a cancelled turn is still unwinding. turnGuard.active is synchronous
    // and reflects "running" here regardless of any UI flag's staleness, so this
    // must stay a no-op.
    expect(dispatched).toBe(0);
    expect(turnGuard.active).toBe(true); // guard untouched — still owned by the live turn
  });

  it("does not dispatch while the guard is merely reserved (dispatching)", async () => {
    const turnGuard = new TurnGuard();
    turnGuard.reserve(); // another wake source already claimed the guard
    let dispatched = 0;
    runSubmittedTurnRef.current = async () => {
      dispatched += 1;
    };
    const requestBackgroundResume = createRequestBackgroundResume({
      agent: { injections: { peek: () => ["pending"] } } as never,
      getBgTasksOpen: () => false,
      autoResumeDispatch: createAutoClearDispatch({ holdMs: 0, scheduler: immediateScheduler }),
      turnGuard,
      postTurnDrain: noopPostTurnDrain,
      runtimeConfig: {} as never,
      setTranscript: () => {},
    });

    requestBackgroundResume();

    expect(dispatched).toBe(0);
  });

  it("does not let the background-task panel block an idle completion wake", () => {
    const turnGuard = new TurnGuard();
    let dispatched = 0;
    runSubmittedTurnRef.current = async () => {
      dispatched += 1;
    };
    const requestBackgroundResume = createRequestBackgroundResume({
      agent: { injections: { peek: () => ["pending"] } } as never,
      getBgTasksOpen: () => true,
      autoResumeDispatch: createAutoClearDispatch({ holdMs: 0, scheduler: immediateScheduler }),
      turnGuard,
      postTurnDrain: noopPostTurnDrain,
      runtimeConfig: {} as never,
      setTranscript: () => {},
    });

    requestBackgroundResume();

    expect(dispatched).toBe(1);
  });

  it("dispatches an empty resume once idle with no queue, reserving the guard first", async () => {
    const turnGuard = new TurnGuard();
    let dispatched = 0;
    runSubmittedTurnRef.current = async () => {
      dispatched += 1;
    };
    const requestBackgroundResume = createRequestBackgroundResume({
      agent: { injections: { peek: () => ["pending"] } } as never,
      getBgTasksOpen: () => false,
      autoResumeDispatch: createAutoClearDispatch({ holdMs: 0, scheduler: immediateScheduler }),
      turnGuard,
      postTurnDrain: noopPostTurnDrain,
      runtimeConfig: {} as never,
      setTranscript: () => {},
    });

    requestBackgroundResume();

    expect(dispatched).toBe(1);
    expect(turnGuard.active).toBe(true); // reserve() claimed the guard for the dispatch
  });
});

describe("requestBackgroundResume standing queue processor (D4 — direct promotion, no empty resume)", () => {
  const realPostTurnDrain = createPostTurnDrain({
    setTranscript: () => {},
  });

  it("promotes a queued slash via handleSlashRef instead of dispatching an empty resume", async () => {
    queueActions.push({ id: "q1", text: "/compact", expanded: "/compact" });
    const turnGuard = new TurnGuard();
    let emptyResumeDispatched = 0;
    runSubmittedTurnRef.current = async (text) => {
      if (text === "") emptyResumeDispatched += 1;
    };
    const handled: { slash: string | null } = { slash: null };
    handleSlashRef.current = (text) => {
      handled.slash = text;
      return true;
    };
    const requestBackgroundResume = createRequestBackgroundResume({
      agent: { injections: { peek: () => [] } } as never,
      getBgTasksOpen: () => false,
      autoResumeDispatch: createAutoClearDispatch({ holdMs: 0, scheduler: immediateScheduler }),
      turnGuard,
      postTurnDrain: realPostTurnDrain,
      runtimeConfig: {} as never,
      setTranscript: () => {},
    });

    requestBackgroundResume();
    await Promise.resolve();
    await Promise.resolve();

    expect(handled.slash).toBe("/compact");
    expect(emptyResumeDispatched).toBe(0); // no pointless empty provider turn
    expect(turnGuard.active).toBe(false); // a slash continuation never reserves the guard
  });

  it("promotes a queued text message as a real turn, reserving the guard first", async () => {
    queueActions.push({ id: "q2", text: "hello", expanded: "hello from the queue" });
    const turnGuard = new TurnGuard();
    const dispatched: { text: string | null } = { text: null };
    runSubmittedTurnRef.current = async (text) => {
      dispatched.text = text;
    };
    const requestBackgroundResume = createRequestBackgroundResume({
      agent: { injections: { peek: () => [] } } as never,
      getBgTasksOpen: () => false,
      autoResumeDispatch: createAutoClearDispatch({ holdMs: 0, scheduler: immediateScheduler }),
      turnGuard,
      postTurnDrain: realPostTurnDrain,
      runtimeConfig: {} as never,
      setTranscript: () => {},
    });

    requestBackgroundResume();
    await Promise.resolve();
    await Promise.resolve();

    expect(dispatched.text).toBe("hello from the queue");
    expect(turnGuard.active).toBe(true); // reserve() claimed the guard ahead of the dispatch
  });
});
