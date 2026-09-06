import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cancelTaskTree,
  clear as clearTasks,
  get as getTask,
  list as listTasks,
  taskRunRef,
} from "@/engine/background/tasks/background.ts";
import * as backgroundControllers from "@/engine/background/tasks/background-controllers.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import * as realSpawn from "../spawn.ts";
import type { ForkInvocation } from "../types.ts";

const dispatchFork = mock((_invocation: ForkInvocation, _ctx: RequestContext) =>
  Promise.resolve({ output: "done", isError: false }),
);

mock.module("@/engine/background/subagents/fork/spawn.ts", () => ({
  ...realSpawn,
  dispatchFork,
}));

const { formatForkSuccessFeedback, hasConversationTurn, launchForkFromDirective } = await import(
  "../spawn-from-directive.ts"
);

afterEach(() => {
  clearTasks();
  backgroundControllers._resetForTests();
  dispatchFork.mockClear();
});

beforeEach(() => {
  backgroundControllers._resetForTests();
  dispatchFork.mockClear();
});

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function baseCtx(messages: Message[]): RequestContext {
  return {
    provider: "anthropic",
    model: "test-model",
    effort: null,
    permissionMode: "default",
    sessionId: "sess-fork-cmd",
    cwd: "/tmp/project",
    parentMessages: messages,
  };
}

describe("hasConversationTurn", () => {
  test("requires a user message", () => {
    expect(hasConversationTurn([])).toBe(false);
    expect(hasConversationTurn([assistantMsg("hi")])).toBe(false);
    expect(hasConversationTurn([userMsg("go")])).toBe(true);
  });
});

describe("launchForkFromDirective", () => {
  test("returns null when there is no conversation turn", () => {
    expect(launchForkFromDirective("do work", baseCtx([]))).toBeNull();
    expect(launchForkFromDirective("do work", baseCtx([assistantMsg("only")]))).toBeNull();
    expect(listTasks()).toHaveLength(0);
    expect(dispatchFork).toHaveBeenCalledTimes(0);
  });

  test("registers a detached background task and returns name + agentId", async () => {
    const result = launchForkFromDirective("Audit the login path", baseCtx([userMsg("hello")]));
    expect(result).not.toBeNull();
    expect(result!.name).toBe("audit-the-login");
    expect(result!.agentId.length).toBeGreaterThan(4);
    const task = getTask(result!.agentId);
    expect(task).toBeDefined();
    expect(task?.isBackgrounded).toBe(true);
    expect(task?.lifecycleMode).toBe("detached");
    expect(task?.agentName).toBe("audit-the-login");
    expect(task?.description).toBe("Audit the login path");
    expect(formatForkSuccessFeedback(result!)).toBe(
      [
        `forked into a background agent · ${result!.name} (${result!.agentId.slice(-4)})`,
        "it carries this conversation up to now and is already working · nothing here changes",
        "track it in the agents panel (↓ to manage) · its result lands here as a notification when it completes",
      ].join("\n"),
    );
    await Bun.sleep(20);
    expect(dispatchFork).toHaveBeenCalled();
    const invocation = dispatchFork.mock.calls[0]?.[0] as ForkInvocation | undefined;
    expect(invocation?.directive).toBe("Audit the login path");
    expect(invocation?.name).toBe("audit-the-login");
    expect(invocation?.runInBackground).toBe(true);
    expect(invocation?.forkId).toBe(result!.agentId);
    expect(invocation?.permissionMode).toBe("default");
  });

  test("aborts the detached run when its task is cancelled", async () => {
    dispatchFork.mockImplementationOnce(
      (_invocation: ForkInvocation, ctx: RequestContext) =>
        new Promise((resolve) => {
          ctx.abortSignal?.addEventListener(
            "abort",
            () => resolve({ output: "Interrupted by user", isError: true }),
            { once: true },
          );
        }),
    );
    const result = launchForkFromDirective("Audit cancellation", baseCtx([userMsg("hello")]));
    expect(result).not.toBeNull();
    await Bun.sleep(0);
    const task = getTask(result!.agentId);
    expect(task).toBeDefined();
    expect(backgroundControllers.get(task!.parentToolCallId)?.taskId).toBe(task!.id);

    expect(
      cancelTaskTree(taskRunRef(task!), {
        reason: "Stopped by user",
        userInitiated: true,
      }),
    ).toBe(true);
    expect(dispatchFork.mock.calls.at(-1)?.[1].abortSignal?.aborted).toBe(true);
    await Bun.sleep(0);
    expect(getTask(result!.agentId)?.status).toBe("killed");
    expect(backgroundControllers.get(task!.parentToolCallId)).toBeUndefined();
  });
});

describe("formatForkSuccessFeedback", () => {
  test("matches glyph + name + last four id chars", () => {
    const feedback = formatForkSuccessFeedback({ name: "review-the-auth", agentId: "a1234wxyz" });
    expect(feedback).toContain("forked into a background agent · review-the-auth (wxyz)");
    expect(feedback).toContain(
      "it carries this conversation up to now and is already working · nothing here changes",
    );
    expect(feedback).toContain("agents panel (↓ to manage)");
    expect(feedback).not.toContain("task list (ctrl+t)");
  });
});
