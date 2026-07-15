// Regression coverage for AGENT-PERM-002: a fork spawn must never set
// `shouldAvoidPermissionPrompts`, regardless of `runInBackground`. Forks always
// carry `inheritParentTurn: true` (a parent turn is present to answer a
// prompt), so backgrounding a fork should only detach its UI — not make its
// asks auto-deny silently at permission-resolution.ts. This mirrors upstream's
// FORK_AGENT `permissionMode: "bubble"`, which still surfaces prompts even for
// an async/backgrounded fork.
//
// This exercises `buildForkSpec` directly (the pure spec-construction split
// out of `dispatchFork`) instead of mocking `runForkLoopExternal`/`dispatchFork`
// via `mock.module`: several sibling test files already mock
// "@/engine/background/subagents/fork/spawn.ts" and
// "@/engine/background/subagents/dispatcher.ts" process-wide (bun's
// mock.module is not file-scoped), which would otherwise make a freshly
// imported `dispatchFork` unreliable here when the whole suite runs together.
import { describe, expect, it } from "bun:test";
import { buildForkSpec } from "@/engine/background/subagents/fork/spawn.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const parentMessages: Message[] = [
  { role: "user", content: [{ type: "text", text: "do the thing" }] },
];

function mainCtx(): RequestContext {
  return {
    provider: "anthropic",
    model: "claude-opus-4-6",
    effort: null,
    permissionMode: "default",
    sessionId: "spawn-fork-bubble-session",
    cwd: "/tmp/project",
    parentMessages,
  } as unknown as RequestContext;
}

describe("dispatchFork permission-prompt bubbling (AGENT-PERM-002)", () => {
  it("never sets shouldAvoidPermissionPrompts for a backgrounded fork", () => {
    const spec = buildForkSpec(
      { directive: "rm a file outside the workspace", runInBackground: true },
      mainCtx(),
      parentMessages,
    );

    expect(spec.inheritParentTurn).toBe(true);
    expect(spec.shouldAvoidPermissionPrompts).toBeUndefined();
  });

  it("never sets shouldAvoidPermissionPrompts for a foreground fork either", () => {
    const spec = buildForkSpec(
      { directive: "rm a file outside the workspace", runInBackground: false },
      mainCtx(),
      parentMessages,
    );

    expect(spec.shouldAvoidPermissionPrompts).toBeUndefined();
  });

  it("never sets shouldAvoidPermissionPrompts when runInBackground is omitted", () => {
    const spec = buildForkSpec(
      { directive: "rm a file outside the workspace" },
      mainCtx(),
      parentMessages,
    );

    expect(spec.shouldAvoidPermissionPrompts).toBeUndefined();
  });
});
