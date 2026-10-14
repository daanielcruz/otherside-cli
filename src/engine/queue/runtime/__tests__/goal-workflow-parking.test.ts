import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clear as clearBackgroundTasks,
  startShellTask,
} from "@/engine/background/tasks/background.ts";
import {
  enrollWorkflowTask,
  resetWorkflowTasksForTests,
} from "@/engine/background/workflows/runtime/store/store.ts";
import type { WorkflowTaskLifecycle } from "@/engine/background/workflows/runtime/store/types.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import * as providers from "@/engine/providers/registry.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import { _resetGoalInterruptionsForTesting } from "@/engine/queue/runtime/goal-after-turn.ts";
import {
  _resetGoalsForTesting,
  getActiveGoal,
  setActiveGoal,
  setGoalDeferral,
} from "@/engine/queue/state.ts";
import { setRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import { scriptedProvider, turnEvents, turnHost } from "./turn-fixture.ts";

registerAllProviders();

function makeRunningWorkflow(id: string, sessionId: string): WorkflowTaskLifecycle {
  return {
    id,
    type: "local_workflow",
    status: "running",
    parentToolCallId: `tool-${id}`,
    workflowRunId: `run-${id}`,
    cwd: process.cwd(),
    sessionId,
    workflowName: "test",
    description: "test workflow",
    workflowProgress: [],
    progressVersion: 0,
    agentCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    logs: [],
    startedAt: Date.now(),
    abortController: new AbortController(),
  };
}

beforeEach(() => {
  _resetGoalsForTesting();
  _resetGoalInterruptionsForTesting();
  resetWorkflowTasksForTests();
  clearBackgroundTasks();
  emitQueue._resetForTests();
  registerAllProviders();
});

afterEach(() => {
  _resetGoalsForTesting();
  _resetGoalInterruptionsForTesting();
  resetWorkflowTasksForTests();
  clearBackgroundTasks();
  emitQueue._resetForTests();
  registerAllProviders();
});

describe("goal background workflow parking", () => {
  test("parks before goal classification while this session owns a running workflow", async () => {
    const sessionId = "session-1";
    const fake = scriptedProvider(["The workflow is still running."]);
    providers.register(fake.provider);
    setActiveGoal(sessionId, "workflow completes");
    enrollWorkflowTask(makeRunningWorkflow("workflow-1", sessionId));

    const events = await turnEvents(turnHost(sessionId));

    expect(fake.calls()).toBe(1);
    expect(events).toContainEqual({
      kind: "goal_paused_bg",
      condition: "workflow completes",
      iteration: 0,
      runningBackgroundTasks: 1,
    });
    expect(events.some((event) => event.kind === "goal_eval_start")).toBe(false);
    expect(events.some((event) => event.kind === "goal_not_met")).toBe(false);
    expect(events.some((event) => event.kind === "goal_continue")).toBe(false);
    expect(getActiveGoal(sessionId)).toBeDefined();
  });

  test("parks before goal classification while this session owns a running background shell", async () => {
    const sessionId = "session-1";
    const fake = scriptedProvider(["The background shell is still running."]);
    providers.register(fake.provider);
    setActiveGoal(sessionId, "shell completes");
    startShellTask({
      shellId: "shell-1",
      command: "sleep 999",
      parentToolCallId: "tool-shell-1",
      sessionId,
    });

    const events = await turnEvents(turnHost(sessionId));

    expect(fake.calls()).toBe(1);
    expect(events).toContainEqual({
      kind: "goal_paused_bg",
      condition: "shell completes",
      iteration: 0,
      runningBackgroundTasks: 1,
    });
    expect(events.some((event) => event.kind === "goal_eval_start")).toBe(false);
    expect(events.some((event) => event.kind === "goal_not_met")).toBe(false);
    expect(events.some((event) => event.kind === "goal_continue")).toBe(false);
    expect(getActiveGoal(sessionId)).toBeDefined();
  });

  test("checks in on the background work once the goal has waited past the interval", async () => {
    const sessionId = "session-1";
    const fake = scriptedProvider(["Waiting on the shell.", "The shell is still making progress."]);
    providers.register(fake.provider);
    setActiveGoal(sessionId, "shell completes");
    const now = Date.now();
    setGoalDeferral(sessionId, { since: now - 31 * 60_000, checkIns: 0, lastPassAt: now - 60_000 });
    startShellTask({
      shellId: "shell-1",
      command: "sleep 999",
      parentToolCallId: "tool-shell-1",
      sessionId,
    });
    const host = turnHost(sessionId);

    const events = await turnEvents(host);

    expect(fake.calls()).toBe(2);
    expect(events.filter((event) => event.kind === "goal_paused_bg")).toHaveLength(2);
    const checkIn = host.deps.session.messages.find(
      (message) =>
        message.role === "user" &&
        message.content.some(
          (block) =>
            block.type === "text" && block.text.startsWith("Goal check-in: «shell completes»"),
        ),
    );
    expect(checkIn).toBeDefined();
    expect(getActiveGoal(sessionId)?.deferral?.checkIns).toBe(1);
  });

  test("does not park for a background shell owned by another session", async () => {
    const sessionId = "session-1";
    const fake = scriptedProvider([
      "This session has no running background shell.",
      '{"ok":true,"reason":"the response confirms no work remains"}',
    ]);
    providers.register(fake.provider);
    setActiveGoal(sessionId, "no work remains");
    startShellTask({
      shellId: "shell-other",
      command: "sleep 999",
      parentToolCallId: "tool-shell-other",
      sessionId: "session-2",
    });

    const events = await turnEvents(turnHost(sessionId));

    expect(fake.calls()).toBe(2);
    expect(events.some((event) => event.kind === "goal_paused_bg")).toBe(false);
    expect(events).toContainEqual({
      kind: "goal_met",
      condition: "no work remains",
      iteration: 1,
    });
    expect(getActiveGoal(sessionId)).toBeUndefined();
  });

  test("does not park for a workflow owned by another session", async () => {
    const sessionId = "session-1";
    const fake = scriptedProvider([
      "This session has no running workflow.",
      '{"ok":true,"reason":"the response confirms no work remains"}',
    ]);
    providers.register(fake.provider);
    setActiveGoal(sessionId, "no work remains");
    enrollWorkflowTask(makeRunningWorkflow("workflow-2", "session-2"));

    const events = await turnEvents(turnHost(sessionId));

    expect(fake.calls()).toBe(2);
    expect(events.some((event) => event.kind === "goal_paused_bg")).toBe(false);
    expect(events).toContainEqual({
      kind: "goal_met",
      condition: "no work remains",
      iteration: 1,
    });
    expect(getActiveGoal(sessionId)).toBeUndefined();
  });

  test("halts repeated unmet continuations at the stop-hook cap", async () => {
    const previousCap = process.env.OTHERSIDE_STOP_HOOK_BLOCK_CAP;
    process.env.OTHERSIDE_STOP_HOOK_BLOCK_CAP = "1";
    setRuntimeKind("interactive");
    try {
      const sessionId = "session-1";
      const fake = scriptedProvider([
        "Still working.",
        '{"ok":false,"reason":"work remains"}',
        "Still working.",
        '{"ok":false,"reason":"work remains"}',
      ]);
      providers.register(fake.provider);
      setActiveGoal(sessionId, "all work completes");

      const events = await turnEvents(turnHost(sessionId));

      expect(fake.calls()).toBe(4);
      expect(events.filter((event) => event.kind === "goal_continue")).toHaveLength(1);
      // Past the cap the turn ends with a warning, not a failure the reader must dismiss.
      expect(events.some((event) => event.kind === "error")).toBe(false);
      const notices = events.filter((event) => event.kind === "turn_notice");
      expect(notices).toEqual([
        {
          kind: "turn_notice",
          text: expect.stringContaining(
            "A hook blocked the turn from ending 2 consecutive times — overriding and ending turn.",
          ),
          level: "warning",
        },
        {
          kind: "turn_notice",
          text: "Goal paused · goal checks kept finding it unmet this turn · send a message to continue",
          level: "notice",
        },
      ]);
      // Nothing runs after the notices: the turn ended there.
      expect(events.at(-1)?.kind).toBe("turn_notice");
      expect(getActiveGoal(sessionId)).toBeDefined();
    } finally {
      setRuntimeKind(null);
      if (previousCap === undefined) delete process.env.OTHERSIDE_STOP_HOOK_BLOCK_CAP;
      else process.env.OTHERSIDE_STOP_HOOK_BLOCK_CAP = previousCap;
    }
  });
});
