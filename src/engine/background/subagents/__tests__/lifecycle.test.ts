import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clear as clearInboxes, enqueue, resolveAgentId } from "@/engine/agents/inbox.ts";
import {
  cancelTaskTree,
  clear as clearBackgroundTasks,
  completeTask,
  get as getBackgroundTask,
  removeTask,
  resetEmitThrottleForTests,
  startTask,
  subscribe,
  subscribeCompletion,
  taskRunRef,
} from "@/engine/background/tasks/background.ts";
import * as bgControllers from "@/engine/background/tasks/background-controllers.ts";
import type { Provider } from "@/engine/contract/types.ts";
import * as providers from "@/engine/providers/registry.ts";
import { loadSubagentTranscript } from "@/engine/session/transcript/subagent-transcript.ts";
import { sessionRecordsToMessages } from "@/engine/session/transcript/to-messages.ts";
import { SendMessage } from "@/engine/tools/builtins/sendmessage.ts";
import { sanitizeMessages } from "@/engine/translator/sanitize.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { runForkLoopExternal } from "../fork/loop.ts";
import { clearAgentSteers, pendingAgentSteerCount, queueAgentSteer } from "../fork/steering.ts";
import {
  clearForkLifecyclesForTests,
  registerRunningFork,
  resumeForkWithMessage,
} from "../lifecycle.ts";

interface RequestCapture {
  ctx: RequestContext;
  messages: Message[];
}

function longAnswer(label: string): ProviderEvent[] {
  return [
    {
      kind: "text_delta",
      text: `${label}: completed with enough detail to finish this turn without an automatic expansion request.`,
    },
    { kind: "message_stop", stop_reason: "stop" },
  ];
}

function registerTestProvider(args: {
  providerId: RequestContext["provider"];
  captures: RequestCapture[];
  waitForFirstTurn: Promise<void>;
}): void {
  let turn = 0;
  providers.register({
    id: args.providerId,
    deferredOverrides: () => ({
      excludeFromCatalog: [],
      alwaysDeclare: [],
      emitDeferredReminder: false,
    }),
    translateRequest: (ctx: RequestContext, messages: Message[]) => {
      args.captures.push({ ctx, messages });
      return { turn };
    },
    stream: async function* () {},
    translateResponse: async function* () {
      const current = turn++;
      if (current === 0) await args.waitForFirstTurn;
      const events =
        current === 0
          ? longAnswer("initial")
          : current === 1
            ? longAnswer("steered")
            : longAnswer("resumed");
      for (const event of events) yield event;
    },
    recoverableError: () => ({ kind: "fail", reason: "test" }),
  } as unknown as Provider);
}

async function waitUntil(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

async function sendMessage(
  to: string,
  message: string,
  ctx: RequestContext,
): Promise<Record<string, unknown>> {
  const result = await SendMessage.run(
    { id: crypto.randomUUID(), name: "SendMessage", input: { to, message } },
    ctx,
  );
  return JSON.parse(String(result.content)) as Record<string, unknown>;
}

function registerCapturingProvider(args: {
  providerId: RequestContext["provider"];
  captures: RequestCapture[];
}): void {
  let turn = 0;
  providers.register({
    id: args.providerId,
    deferredOverrides: () => ({
      excludeFromCatalog: [],
      alwaysDeclare: [],
      emitDeferredReminder: false,
    }),
    translateRequest: (ctx: RequestContext, messages: Message[]) => {
      args.captures.push({ ctx, messages });
      return { turn };
    },
    stream: async function* () {},
    translateResponse: async function* () {
      const current = turn++;
      for (const event of longAnswer(`turn-${current}`)) yield event;
    },
    recoverableError: () => ({ kind: "fail", reason: "test" }),
  } as unknown as Provider);
}

function completionForGeneration(taskId: string, generation: number): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = subscribeCompletion((completed) => {
      if (completed.id !== taskId || completed.runGeneration !== generation) return;
      unsubscribe();
      resolve();
    });
  });
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function minimalCtx(providerId: string, sessionId: string): RequestContext {
  return {
    provider: providerId as RequestContext["provider"],
    model: "test-model",
    effort: null,
    permissionMode: "default",
    cwd: "/tmp",
    sessionId,
  };
}

function forkSpecFor(ctx: RequestContext, name: string): Parameters<typeof registerRunningFork>[2] {
  return { ctx, name, body: "", allowSet: null, prompt: "initial" };
}

afterEach(() => {
  clearInboxes();
  clearBackgroundTasks();
  resetEmitThrottleForTests();
  bgControllers._resetForTests();
  clearForkLifecyclesForTests();
});

describe("subagent messaging lifecycle", () => {
  test("delivers a running message at the next boundary and resumes finished context", async () => {
    const storageCwd = mkdtempSync(join(tmpdir(), "otherside-agent-storage-"));
    const agentCwd = mkdtempSync(join(tmpdir(), "otherside-agent-cwd-"));
    const providerId = "agent-resume-test" as RequestContext["provider"];
    const captures: RequestCapture[] = [];
    let releaseFirstTurn = (): void => {};
    const firstTurnGate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });
    registerTestProvider({ providerId, captures, waitForFirstTurn: firstTurnGate });

    const task = startTask({
      parentToolCallId: "agent-tool-call",
      agentName: "resume-worker",
      agentId: "general-purpose",
      cwd: storageCwd,
      sessionId: "resume-session",
      isBackgrounded: true,
    });
    const ctx: RequestContext = {
      provider: providerId,
      model: "resume-model",
      effort: null,
      permissionMode: "default",
      cwd: agentCwd,
      originalCwd: storageCwd,
      sessionId: "resume-session",
      bgTaskId: task.id,
    };
    const inheritedMessages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Parent context marker that must survive resume." }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Parent context acknowledged." }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Original worker directive." }],
      },
    ];

    const initialRun = runForkLoopExternal({
      ctx,
      name: "resume-worker",
      body: "Keep the inherited context and follow steering messages.",
      allowSet: null,
      prompt: "Original worker directive.",
      forkId: task.id,
      agentId: "general-purpose",
      initialMessages: inheritedMessages,
      inheritParentTurn: true,
      permissionMode: "plan",
    });

    await waitUntil(() => resolveAgentId(task.id) === task.id);
    expect(await sendMessage("resume-worker", "Running steering marker.", ctx)).toMatchObject({
      delivered: true,
      to: task.id,
      resumed: false,
    });
    releaseFirstTurn();
    const initialResult = await initialRun;
    completeTask(task.id, { content: initialResult.output, isError: initialResult.isError });

    expect(captures).toHaveLength(2);
    expect(captures[0]?.ctx.cwd).toBe(agentCwd);
    expect(captures[0]?.ctx.permissionMode).toBe("plan");
    expect(JSON.stringify(captures[1]?.messages)).toContain("Running steering marker.");
    expect(resolveAgentId(task.id)).toBeNull();
    expect(removeTask(task.id)).toBe(true);

    const resumedCompletion = new Promise<void>((resolve) => {
      const unsubscribe = subscribeCompletion((completed) => {
        if (completed.id !== task.id || completed.runGeneration !== 1) return;
        unsubscribe();
        resolve();
      });
    });
    const resumed = await sendMessage("resume-worker", "Finished follow-up marker.", ctx);
    expect(resumed).toMatchObject({ delivered: true, to: task.id, resumed: true });
    await resumedCompletion;

    expect(captures).toHaveLength(3);
    const resumedTranscript = JSON.stringify(captures[2]?.messages);
    expect(resumedTranscript).toContain("Parent context marker that must survive resume.");
    expect(resumedTranscript).toContain("Running steering marker.");
    expect(resumedTranscript).toContain("Finished follow-up marker.");
    clearAgentSteers(task.id);
  });

  test("reports unknown and non-resumable recipients distinctly", async () => {
    const ctx: RequestContext = {
      provider: "resume-failure-test" as RequestContext["provider"],
      model: "resume-model",
      effort: null,
      permissionMode: "default",
      cwd: "/tmp",
      sessionId: "missing-task-session",
    };
    const unknown = await sendMessage("missing-worker", "continue", ctx);
    expect(unknown).toMatchObject({ delivered: false, code: "unknown_agent" });
    const release = registerRunningFork(
      "missing-task-agent",
      "missing-task-worker",
      {
        ctx,
        name: "missing-task-worker",
        body: "",
        allowSet: null,
        prompt: "initial",
      },
      ctx,
    );
    release();

    const notResumable = await sendMessage("missing-task-agent", "continue", ctx);
    expect(notResumable).toMatchObject({ delivered: false, code: "not_resumable" });

    const stoppedTask = startTask({
      parentToolCallId: "stopped-tool-call",
      agentName: "stopped-worker",
    });
    const releaseStopped = registerRunningFork(
      stoppedTask.id,
      "stopped-worker",
      {
        ctx,
        name: "stopped-worker",
        body: "",
        allowSet: null,
        prompt: "initial",
      },
      ctx,
    );
    releaseStopped();
    completeTask(stoppedTask.id, {
      content: "Stopped by user",
      isError: false,
      killed: true,
      userInitiated: true,
    });

    const stopped = await sendMessage(stoppedTask.id, "continue", ctx);
    expect(stopped).toMatchObject({ delivered: false, code: "stopped_by_user" });
  });

  test("a running name holder keeps its alias when a later fork claims the same name", () => {
    const ctx = minimalCtx("name-claim-test", "name-claim-session");
    const releaseA = registerRunningFork(
      "name-claim-a",
      "shared-name",
      forkSpecFor(ctx, "shared-name"),
      ctx,
    );
    const releaseB = registerRunningFork(
      "name-claim-b",
      "shared-name",
      forkSpecFor(ctx, "shared-name"),
      ctx,
    );

    // The alias stays pinned to the still-running holder A; B is reachable by id.
    expect(resolveAgentId("shared-name")).toBe("name-claim-a");
    expect(resolveAgentId("name-claim-b")).toBe("name-claim-b");

    // A message addressed to the shared name reaches A, not the later claimant B.
    const delivery = enqueue("shared-name", "for the running holder");
    expect(delivery.delivered).toBe(true);
    expect(pendingAgentSteerCount("name-claim-a")).toBe(1);
    expect(pendingAgentSteerCount("name-claim-b")).toBe(0);

    releaseA();
    releaseB();
    clearAgentSteers("name-claim-a");
  });

  test("a fork whose abort already fired rejects fast-path inbox delivery", () => {
    const aborter = new AbortController();
    aborter.abort();
    const ctx: RequestContext = {
      ...minimalCtx("stopping-abort-test", "stopping-abort-session"),
      abortSignal: aborter.signal,
    };
    const release = registerRunningFork(
      "stopping-abort-agent",
      "stopping-abort-worker",
      forkSpecFor(ctx, "stopping-abort-worker"),
      ctx,
    );

    const result = enqueue("stopping-abort-agent", "continue");
    expect(result.delivered).toBe(false);
    if (!result.delivered) expect(result.code).toBe("inbox_unavailable");
    expect(pendingAgentSteerCount("stopping-abort-agent")).toBe(0);

    release();
  });

  test("resume reports stopped_by_user while the stopped fork's inbox is still registered", async () => {
    const ctx = minimalCtx("stopped-live-test", "stopped-live-session");
    const stoppedTask = startTask({
      parentToolCallId: "stopped-live-call",
      agentName: "stopped-live-worker",
    });
    // Intentionally do NOT release the inbox before completing: the delivery
    // handler is still registered, so this exercises the stopping gate on the
    // fast path (the previous test dodges this window with an early release).
    registerRunningFork(
      stoppedTask.id,
      "stopped-live-worker",
      forkSpecFor(ctx, "stopped-live-worker"),
      ctx,
    );
    completeTask(stoppedTask.id, {
      content: "Stopped by user",
      isError: false,
      killed: true,
      userInitiated: true,
    });

    const stopped = await sendMessage(stoppedTask.id, "continue", ctx);
    expect(stopped).toMatchObject({ delivered: false, code: "stopped_by_user" });
    expect(pendingAgentSteerCount(stoppedTask.id)).toBe(0);
  });

  test("does not launch a resumed generation cancelled after reopening", async () => {
    const storageCwd = mkdtempSync(join(tmpdir(), "otherside-resume-cancel-"));
    const providerId = "resume-cancel-test" as RequestContext["provider"];
    const captures: RequestCapture[] = [];
    registerCapturingProvider({ providerId, captures });

    const task = startTask({
      parentToolCallId: "resume-cancel-call",
      agentName: "resume-cancel-worker",
      agentId: "general-purpose",
      cwd: storageCwd,
      sessionId: "resume-cancel-session",
      isBackgrounded: true,
    });
    const ctx: RequestContext = {
      provider: providerId,
      model: "resume-model",
      effort: null,
      permissionMode: "default",
      cwd: storageCwd,
      originalCwd: storageCwd,
      sessionId: "resume-cancel-session",
      bgTaskId: task.id,
    };
    const initialResult = await runForkLoopExternal({
      ctx,
      name: "resume-cancel-worker",
      body: "Complete the task.",
      allowSet: null,
      prompt: "Initial directive.",
      forkId: task.id,
      agentId: "general-purpose",
    });
    completeTask(task.id, { content: initialResult.output, isError: initialResult.isError });
    resetEmitThrottleForTests();

    let cancellationQueued = false;
    let cancellationApplied = false;
    const unsubscribe = subscribe(() => {
      const current = getBackgroundTask(task.id);
      if (cancellationQueued || current?.runGeneration !== 1 || current.status !== "running")
        return;
      cancellationQueued = true;
      queueMicrotask(() => {
        const reopened = getBackgroundTask(task.id);
        if (reopened === undefined) return;
        cancellationApplied = cancelTaskTree(taskRunRef(reopened), {
          reason: "cancel during resume",
          userInitiated: true,
        });
      });
    });

    try {
      const resumed = await resumeForkWithMessage(task.id, "Resume directive.", ctx);
      expect(cancellationQueued).toBe(true);
      expect(cancellationApplied).toBe(true);
      expect(resumed).toMatchObject({ delivered: false, code: "stopped_by_user" });
      expect(getBackgroundTask(task.id)?.status).toBe("killed");
      expect(captures).toHaveLength(1);
      expect(bgControllers.callIds()).not.toContain(task.parentToolCallId);
    } finally {
      unsubscribe();
      rmSync(storageCwd, { recursive: true, force: true });
    }
  });

  test("resumes undrained steers before the prompt and persists them exactly once", async () => {
    const storageCwd = mkdtempSync(join(tmpdir(), "otherside-steer-storage-"));
    const providerId = "steer-persist-test" as RequestContext["provider"];
    const captures: RequestCapture[] = [];
    registerCapturingProvider({ providerId, captures });

    const task = startTask({
      parentToolCallId: "steer-tool-call",
      agentName: "steer-worker",
      agentId: "general-purpose",
      cwd: storageCwd,
      sessionId: "steer-session",
      isBackgrounded: true,
    });
    const ctx: RequestContext = {
      provider: providerId,
      model: "steer-model",
      effort: null,
      permissionMode: "default",
      cwd: storageCwd,
      originalCwd: storageCwd,
      sessionId: "steer-session",
      bgTaskId: task.id,
    };

    // Seed the transcript with the first prompt and its assistant reply.
    const initialResult = await runForkLoopExternal({
      ctx,
      name: "steer-worker",
      body: "Follow steering messages.",
      allowSet: null,
      prompt: "Original directive.",
      forkId: task.id,
      agentId: "general-purpose",
    });
    completeTask(task.id, { content: initialResult.output, isError: initialResult.isError });

    // Two steers arrive while the fork is finished; they stay undrained.
    queueAgentSteer(task.id, {
      text: "Steer one.",
      blocks: [{ type: "text", text: "Steer one." }],
    });
    queueAgentSteer(task.id, {
      text: "Steer two.",
      blocks: [{ type: "text", text: "Steer two." }],
    });

    const firstCompletion = completionForGeneration(task.id, 1);
    const firstResume = await resumeForkWithMessage(task.id, "First resume prompt.");
    expect(firstResume).toMatchObject({ delivered: true, resumed: true });
    await firstCompletion;

    // FIX 2a — the resumed run receives [history..., steer1, steer2, prompt] in
    // chronological order (steers before the new prompt, not appended after it).
    const firstJson = JSON.stringify(captures.at(-1)?.messages ?? []);
    const original = firstJson.indexOf("Original directive.");
    const steerOne = firstJson.indexOf("Steer one.");
    const steerTwo = firstJson.indexOf("Steer two.");
    const firstPrompt = firstJson.indexOf("First resume prompt.");
    expect(original).toBeGreaterThanOrEqual(0);
    expect(steerOne).toBeGreaterThan(original);
    expect(steerTwo).toBeGreaterThan(steerOne);
    expect(firstPrompt).toBeGreaterThan(steerTwo);

    // The steers were drained, so nothing is left to re-inject on a later resume.
    expect(pendingAgentSteerCount(task.id)).toBe(0);

    // FIX 2b — the durable transcript (the history any fresh resume rebuilds from)
    // now carries both steers exactly once, ahead of the first resume prompt.
    const rebuild = async (): Promise<string> => {
      const records = await loadSubagentTranscript({
        cwd: storageCwd,
        sessionId: "steer-session",
        forkId: task.id,
      });
      return JSON.stringify(sanitizeMessages(sessionRecordsToMessages(records)));
    };
    const afterFirst = await rebuild();
    expect(occurrences(afterFirst, "Steer one.")).toBe(1);
    expect(occurrences(afterFirst, "Steer two.")).toBe(1);
    expect(afterFirst.indexOf("Steer one.")).toBeLessThan(
      afterFirst.indexOf("First resume prompt."),
    );
    expect(afterFirst.indexOf("Steer two.")).toBeLessThan(
      afterFirst.indexOf("First resume prompt."),
    );

    // Resume again: the steers arrive through history, not the queue, so the
    // transcript still holds them exactly once (they are not persisted twice).
    const secondCompletion = completionForGeneration(task.id, 2);
    const secondResume = await resumeForkWithMessage(task.id, "Second resume prompt.");
    expect(secondResume).toMatchObject({ delivered: true, resumed: true });
    await secondCompletion;

    const afterSecond = await rebuild();
    expect(occurrences(afterSecond, "Steer one.")).toBe(1);
    expect(occurrences(afterSecond, "Steer two.")).toBe(1);

    clearAgentSteers(task.id);
  });
});
