import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SlashCommand } from "@/commands/catalog.ts";
import type { SlashContext } from "@/commands/types.ts";
import * as realSpawn from "@/engine/background/subagents/fork/spawn.ts";
import type { ForkInvocation } from "@/engine/background/subagents/fork/types.ts";
import { clear as clearTasks } from "@/engine/background/tasks/background.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const dispatchFork = mock((_invocation: ForkInvocation, _ctx: RequestContext) =>
  Promise.resolve({ output: "ok", isError: false }),
);

mock.module("@/engine/background/subagents/fork/spawn.ts", () => ({
  ...realSpawn,
  dispatchFork,
}));

const { FORK_NO_TURN_FEEDBACK, FORK_USAGE_FEEDBACK, handleFork } = await import("../fork.ts");

const cmd: SlashCommand = {
  name: "fork",
  kind: "instant",
  description: "Spawn a background agent that inherits the full conversation",
  argumentHint: "<directive>",
};

function makeCtx(messages: Message[]): SlashContext {
  return {
    broker: {
      read: () => ({
        provider: "anthropic",
        model: "test-model",
        effort: null,
        fastMode: false,
        permissionMode: "default",
      }),
      dispatch: () => {},
    } as unknown as SlashContext["broker"],
    session: {
      id: "sess-1",
      cwd: "/tmp/project",
      storageCwd: "/tmp/project",
      messages,
      worktree: null,
      additionalWorkingDirectories: new Set(["/tmp/shared"]),
    } as unknown as SlashContext["session"],
    agent: {
      deps: {
        session: {
          id: "sess-1",
          cwd: "/tmp/project",
          storageCwd: "/tmp/project",
          worktree: null,
          messages,
          additionalWorkingDirectories: new Set(["/tmp/shared"]),
        },
        broker: {
          read: () => ({
            provider: "anthropic",
            model: "test-model",
            effort: null,
            fastMode: false,
            permissionMode: "default",
            orchestrationMode: "feudalism",
          }),
        },
        config: { quotaFallback: false },
      },
      injections: { push: () => {} },
      sessionAllowedToolPatterns: new Set(),
    } as unknown as SlashContext["agent"],
    exit: () => {},
    clearTranscript: () => {},
    openOverlay: () => {},
  };
}

beforeEach(() => {
  dispatchFork.mockClear();
});

afterEach(() => {
  clearTasks();
  dispatchFork.mockClear();
});

describe("handleFork", () => {
  test("usage when directive is missing", async () => {
    const result = await handleFork(
      cmd,
      "   ",
      makeCtx([{ role: "user", content: [{ type: "text", text: "hi" }] }]),
    );
    expect(result.feedback).toBe(FORK_USAGE_FEEDBACK);
    expect(result.kind).toBe("instant");
    expect(dispatchFork).toHaveBeenCalledTimes(0);
  });

  test("cannot fork before the first conversation turn", async () => {
    const result = await handleFork(cmd, "do the thing", makeCtx([]));
    expect(result.feedback).toBe(FORK_NO_TURN_FEEDBACK);
    expect(dispatchFork).toHaveBeenCalledTimes(0);
  });

  test("success feedback names the fork and points at the agents panel", async () => {
    const result = await handleFork(
      cmd,
      "Review the auth flow",
      makeCtx([{ role: "user", content: [{ type: "text", text: "hi" }] }]),
    );
    expect(result.kind).toBe("instant");
    // The row already carries the transcript's own gutter mark, so the feedback
    // opens on its text rather than repeating a fork glyph beside it.
    expect(result.feedback).toMatch(
      /^forked into a background agent · review-the-auth \([0-9a-z]{4}\)\n/,
    );
    expect(result.feedback).toContain("agents panel (↓ to manage)");
    expect(result.feedback).not.toContain("ctrl+t");
    await Bun.sleep(20);
    expect(dispatchFork).toHaveBeenCalled();
    const parentCtx = dispatchFork.mock.calls.at(-1)?.[1];
    expect(parentCtx?.orchestrationMode).toBe("feudalism");
    expect(parentCtx?.quotaFallbackEnabled).toBe(false);
    expect(parentCtx?.additionalWorkingDirectories).toEqual(new Set(["/tmp/shared"]));
    expect(parentCtx?.parentMessages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });
});
