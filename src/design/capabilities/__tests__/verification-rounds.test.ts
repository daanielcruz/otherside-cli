import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForkSpec, SubagentResult } from "@/engine/background/subagents/fork/types.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const realDispatcher = await import("@/engine/background/subagents/dispatcher.ts");
const realVerifier = await import("@/design/verifier.ts");
// Captured before mocking: the namespace objects are re-bound in place once a
// stand-in is installed, so spreading them later would restore the stand-in.
const realRunForkLoopExternal = realDispatcher.runForkLoopExternal;
const realDrainVerificationQueue = realVerifier.drainVerificationQueue;

type ForkRun = (spec: ForkSpec) => Promise<SubagentResult>;
type Drain = typeof realVerifier.drainVerificationQueue;

let forkRun: ForkRun = async () => ({ output: "", isError: false });
let drain: Drain = async () => [];

mock.module("@/engine/background/subagents/dispatcher.ts", () => ({
  ...realDispatcher,
  runForkLoopExternal: (spec: ForkSpec) => forkRun(spec),
}));
mock.module("@/design/verifier.ts", () => ({
  ...realVerifier,
  drainVerificationQueue: (args: Parameters<Drain>[0]) => drain(args),
}));

// The stand-ins must not outlive this file: later test files import the real
// modules through the same specifiers.
afterAll(() => {
  mock.module("@/engine/background/subagents/dispatcher.ts", () => ({
    ...realDispatcher,
    runForkLoopExternal: realRunForkLoopExternal,
  }));
  mock.module("@/design/verifier.ts", () => ({
    ...realVerifier,
    drainVerificationQueue: realDrainVerificationQueue,
  }));
});

const { runVerificationRounds } = await import("@/design/capabilities/verification-rounds.ts");
const { createDesignSnapshot } = await import("@/design/snapshot.ts");
const { saveDesignSnapshot } = await import("@/design/storage.ts");
const {
  drainDesignSteers,
  isDesignTurnActive,
  ownsDesignTurn,
  registerDesignTurn,
  setDesignTurnSteerable,
  steerDesignTurn,
  unregisterDesignTurn,
} = await import("@/design/turns.ts");
type RpcContext = import("@/design/types.ts").RpcContext;

const DESIGN_ID = "design-rounds";
let configRoot: string;
let originalConfigRoot: string | undefined;

beforeEach(() => {
  originalConfigRoot = process.env.OTHERSIDE_CONFIG_DIR;
  configRoot = mkdtempSync(join(tmpdir(), "otherside-design-rounds-"));
  process.env.OTHERSIDE_CONFIG_DIR = configRoot;
});

afterEach(() => {
  if (originalConfigRoot === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = originalConfigRoot;
  rmSync(configRoot, { recursive: true, force: true });
});

function harness() {
  const cwd = join(configRoot, "project");
  const snapshot = createDesignSnapshot({ designId: DESIGN_ID });
  saveDesignSnapshot(cwd, snapshot);
  const notifications: unknown[] = [];
  const ctx = {
    cwd,
    codebaseRoot: cwd,
    designId: DESIGN_ID,
    activeDesignId: DESIGN_ID,
    snapshots: new Map([[DESIGN_ID, snapshot]]),
    emit: (notification: unknown) => notifications.push(notification),
    send: () => {},
  } as unknown as RpcContext;
  const turnController = new AbortController();
  const requestContext = { abortSignal: turnController.signal } as unknown as RequestContext;
  registerDesignTurn(DESIGN_ID, turnController);
  setDesignTurnSteerable(DESIGN_ID, turnController, false);
  const toolset = { allowSet: new Set<string>(), declarations: [], scopedTools: [] };
  const run = () =>
    runVerificationRounds({
      ctx,
      designId: DESIGN_ID,
      streamId: 1,
      requestContext,
      turnController,
      toolset: toolset as never,
      turnIndex: 0,
    });
  return { ctx, turnController, run, notifications };
}

describe("verification rounds", () => {
  test("a repair round accepts and drains a steer, then closes the window", async () => {
    const { turnController, run } = harness();
    let rounds = 0;
    drain = async () => (rounds++ === 0 ? [{ path: "index.html", description: "off" }] : []);
    const drained: string[][] = [];
    const steeredDuringFork: boolean[] = [];
    forkRun = async (spec) => {
      steeredDuringFork.push(steerDesignTurn(DESIGN_ID, "make it blue"));
      drained.push((spec.pendingUserInputDrainer?.() ?? []).map((message) => message.text));
      return { output: "repaired", isError: false };
    };

    expect(steerDesignTurn(DESIGN_ID, "before the repair")).toBe(false);
    await run();

    expect(steeredDuringFork).toEqual([true]);
    expect(drained).toEqual([["make it blue"]]);
    expect(steerDesignTurn(DESIGN_ID, "after the rounds")).toBe(false);
    expect(drainDesignSteers(DESIGN_ID)).toEqual([]);
    expect(ownsDesignTurn(DESIGN_ID, turnController)).toBe(true);
    unregisterDesignTurn(DESIGN_ID, turnController);
  });

  test("a message during the verifier starts a new turn and stops the rounds", async () => {
    const { turnController, run } = harness();
    const next = new AbortController();
    let forkRuns = 0;
    forkRun = async () => {
      forkRuns += 1;
      return { output: "", isError: false };
    };
    drain = async () => {
      registerDesignTurn(DESIGN_ID, next);
      return [{ path: "index.html", description: "verifier still had findings" }];
    };

    await run();

    expect(turnController.signal.aborted).toBe(true);
    expect(turnController.signal.reason).toBe("superseded");
    expect(forkRuns).toBe(0);
    expect(ownsDesignTurn(DESIGN_ID, next)).toBe(true);
    expect(isDesignTurnActive(DESIGN_ID)).toBe(true);
    unregisterDesignTurn(DESIGN_ID, next);
  });

  test("a clean verification runs no repair fork", async () => {
    const { turnController, run } = harness();
    let forkRuns = 0;
    forkRun = async () => {
      forkRuns += 1;
      return { output: "", isError: false };
    };
    drain = async () => [];

    await run();

    expect(forkRuns).toBe(0);
    expect(turnController.signal.aborted).toBe(false);
    unregisterDesignTurn(DESIGN_ID, turnController);
  });
});
