import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type AgentContext, runWithAgentContext } from "@/engine/agents/agent-context.ts";
import type {
  ForkInvocation,
  SubagentInvocation,
} from "@/engine/background/subagents/dispatcher.ts";
import * as realDispatcher from "@/engine/background/subagents/dispatcher.ts";
import {
  AGENT_MULTIPROVIDER_ONLY_FIELDS,
  AGENT_OPTIONS,
} from "@/engine/tools/dynamic/agent-options.ts";
import agentTool from "@/harness/tools/Agent/tool.json" with { type: "json" };
import type { ToolCall } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const dispatchSubagent = mock((_invocation: SubagentInvocation) =>
  Promise.resolve({ output: "ok", isError: false }),
);
const dispatchFork = mock((_invocation: ForkInvocation) =>
  Promise.resolve({ output: "forked", isError: false }),
);

// Partial override: keep the real module's other exports (resolveWorkflowAgentProfile,
// runForkLoopExternal, …) so sibling test files that import the real dispatcher via
// bridge.ts still resolve them — mock.module is process-global, not file-scoped.
mock.module("@/engine/background/subagents/dispatcher.ts", () => ({
  ...realDispatcher,
  dispatchSubagent,
  dispatchFork,
}));

const { Agent } = await import("../agent.ts");

const baseCtx = {
  multiproviderEnabled: true,
  provider: "anthropic",
  model: "claude-sonnet-4-6",
} as unknown as RequestContext;

const childAgentContext: AgentContext = {
  agentId: "named-child",
  depth: 1,
  parentSessionId: "session-test",
  agentType: "subagent",
  subagentName: "general-purpose",
  sessionAllowedToolPatterns: new Set<string>(),
};

function makeCall(input: Record<string, unknown>): ToolCall {
  return { id: "call-test", name: "Agent", input };
}

describe("Agent tool fork vs named subagent", () => {
  beforeEach(() => {
    dispatchSubagent.mockClear();
    dispatchFork.mockClear();
  });

  afterEach(() => {
    dispatchSubagent.mockClear();
    dispatchFork.mockClear();
  });

  test("uses the general-purpose clean subagent when subagent_type is omitted", async () => {
    await Agent.run(makeCall({ description: "test", prompt: "do it" }), baseCtx);

    expect(dispatchSubagent).toHaveBeenCalledTimes(1);
    expect(dispatchFork).toHaveBeenCalledTimes(0);
    expect(dispatchSubagent.mock.calls[0]?.[0]?.subagentType).toBe("general-purpose");
  });

  test("allows a fork child to launch an omitted-type general-purpose agent", async () => {
    await Agent.run(makeCall({ description: "test", prompt: "do it" }), {
      ...baseCtx,
      agentOwnerId: "fork-parent",
      isForkChild: true,
    });

    expect(dispatchSubagent).toHaveBeenCalledTimes(1);
    expect(dispatchFork).toHaveBeenCalledTimes(0);
    const args = dispatchSubagent.mock.calls[0]?.[0];
    if (!args) throw new Error("expected dispatchSubagent call");
    expect(args.subagentType).toBe("general-purpose");
    expect(args.runInBackground).toBe(true);
  });

  test("dispatches a named subagent and forwards the tier", async () => {
    await Agent.run(
      makeCall({
        description: "test",
        prompt: "do it",
        subagent_type: " explore ",
        tier: "warrior",
      }),
      baseCtx,
    );

    expect(dispatchSubagent).toHaveBeenCalledTimes(1);
    const args = dispatchSubagent.mock.calls[0]?.[0];
    if (!args) throw new Error("expected dispatchSubagent call");
    expect(args.subagentType).toBe("explore");
    expect(args.tierOverride).toBe("warrior");
  });

  test("allows a named child to launch another named agent", async () => {
    await Agent.run(makeCall({ description: "test", prompt: "do it", subagent_type: "explore" }), {
      ...baseCtx,
      agentOwnerId: "named-parent",
    });

    expect(dispatchSubagent).toHaveBeenCalledTimes(1);
    expect(dispatchFork).toHaveBeenCalledTimes(0);
    expect(dispatchSubagent.mock.calls[0]?.[0]?.subagentType).toBe("explore");
  });

  test("allows tier on an omitted (general-purpose) subagent", async () => {
    await Agent.run(makeCall({ description: "test", prompt: "do it", tier: "warrior" }), baseCtx);

    expect(dispatchFork).toHaveBeenCalledTimes(0);
    expect(dispatchSubagent).toHaveBeenCalledTimes(1);
    const args = dispatchSubagent.mock.calls[0]?.[0];
    if (!args) throw new Error("expected dispatchSubagent call");
    expect(args.subagentType).toBe("general-purpose");
    expect(args.tierOverride).toBe("warrior");
  });

  test("routes subagent_type 'fork' to the inheriting fork, not a clean subagent", async () => {
    await Agent.run(
      makeCall({ description: "test", prompt: "do it", subagent_type: "fork" }),
      baseCtx,
    );

    expect(dispatchFork).toHaveBeenCalledTimes(1);
    expect(dispatchSubagent).toHaveBeenCalledTimes(0);
  });

  for (const subagentType of ["  fork  ", "FORK", "Fork"]) {
    test(`routes subagent_type ${JSON.stringify(subagentType)} to the inheriting fork`, async () => {
      await Agent.run(
        makeCall({ description: "test", prompt: "do it", subagent_type: subagentType }),
        baseCtx,
      );

      expect(dispatchFork).toHaveBeenCalledTimes(1);
      expect(dispatchSubagent).toHaveBeenCalledTimes(0);
    });
  }

  test("rejects fork inside a forked worker", async () => {
    const result = await Agent.run(
      makeCall({ description: "test", prompt: "do it", subagent_type: "fork" }),
      { ...baseCtx, agentOwnerId: "fork-parent", isForkChild: true },
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toBe(
      "Fork is only available from the main agent. Complete your task directly or launch a named agent instead.",
    );
    expect(dispatchFork).toHaveBeenCalledTimes(0);
  });

  test("rejects fork from a named child", async () => {
    const result = await Agent.run(
      makeCall({ description: "test", prompt: "do it", subagent_type: "fork" }),
      { ...baseCtx, agentOwnerId: "named-parent" },
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toBe(
      "Fork is only available from the main agent. Complete your task directly or launch a named agent instead.",
    );
    expect(dispatchFork).toHaveBeenCalledTimes(0);
  });

  test("rejects fork when the child marker is available only through agent context", async () => {
    const result = await runWithAgentContext(childAgentContext, () =>
      Agent.run(makeCall({ description: "test", prompt: "do it", subagent_type: "fork" }), baseCtx),
    );

    expect(result.is_error).toBe(true);
    expect(dispatchFork).toHaveBeenCalledTimes(0);
  });

  test("rejects tier on a named fork", async () => {
    const result = await Agent.run(
      makeCall({ description: "test", prompt: "do it", subagent_type: "fork", tier: "warrior" }),
      baseCtx,
    );

    expect(dispatchFork).toHaveBeenCalledTimes(0);
    expect(dispatchSubagent).toHaveBeenCalledTimes(0);
    expect(result.is_error).toBe(true);
  });

  test("silently ignores model on a fork (fork inherits the parent model)", async () => {
    const result = await Agent.run(
      makeCall({
        description: "test",
        prompt: "do it",
        subagent_type: "fork",
        model: "claude-haiku-4-5",
      }),
      baseCtx,
    );

    // model is accepted at the wire but never reaches the fork invocation
    // (ForkInvocation carries no model field), so the fork inherits the parent.
    expect(result.is_error).toBeUndefined();
    expect(dispatchFork).toHaveBeenCalledTimes(1);
    expect(dispatchSubagent).toHaveBeenCalledTimes(0);
  });

  test("forwards name, cwd, and the background task id without a permission override", async () => {
    await Agent.run(
      makeCall({
        description: "test",
        prompt: "do it",
        name: "worker-1",
        cwd: "/tmp/agent-cwd",
      }),
      { ...baseCtx, bgTaskId: "agent-task-id" },
    );

    const args = dispatchSubagent.mock.calls[0]?.[0];
    if (!args) throw new Error("expected dispatchSubagent call");
    expect(args.name).toBe("worker-1");
    expect(args.permissionMode).toBeUndefined();
    expect(args.cwd).toBe("/tmp/agent-cwd");
    expect(args.forkId).toBe("agent-task-id");
  });

  test("forwards cwd to a fork without a permission override", async () => {
    await Agent.run(
      makeCall({
        description: "test",
        prompt: "do it",
        subagent_type: "fork",
        cwd: "/tmp/fork-cwd",
      }),
      baseCtx,
    );

    const args = dispatchFork.mock.calls[0]?.[0];
    if (!args) throw new Error("expected dispatchFork call");
    expect(args.permissionMode).toBeUndefined();
    expect(args.cwd).toBe("/tmp/fork-cwd");
  });

  test("rejects cwd combined with worktree isolation", async () => {
    const result = await Agent.run(
      makeCall({
        description: "test",
        prompt: "do it",
        cwd: "/tmp/agent-cwd",
        isolation: "worktree",
      }),
      baseCtx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("mutually exclusive");
    expect(dispatchSubagent).toHaveBeenCalledTimes(0);
  });

  test("resolves remote isolation to local worktree", async () => {
    const result = await Agent.run(
      makeCall({ description: "test", prompt: "do it", isolation: "remote" }),
      baseCtx,
    );

    expect(result.is_error).toBeUndefined();
    const args = dispatchSubagent.mock.calls[0]?.[0];
    if (!args) throw new Error("expected dispatchSubagent call");
    expect(args.isolation).toBe("worktree");
    expect(dispatchFork).toHaveBeenCalledTimes(0);
  });

  test.each([
    "_worker",
    "worker space",
    "worker!",
    " worker",
    "a".repeat(65),
  ])("rejects invalid agent name %s", async (name) => {
    const result = await Agent.run(
      makeCall({ description: "test", prompt: "do it", name }),
      baseCtx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain(
      "name must begin with a letter or digit and may then include only letters, digits, underscores, or hyphens",
    );
    expect(dispatchSubagent).toHaveBeenCalledTimes(0);
  });

  test("rejects the reserved main name", async () => {
    const result = await Agent.run(
      makeCall({ description: "test", prompt: "do it", name: "main" }),
      baseCtx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('"main" is reserved');
    expect(dispatchSubagent).toHaveBeenCalledTimes(0);
  });
});

describe("Agent option descriptor SoT", () => {
  test("descriptor names are pinned to the wire schema properties", () => {
    const schemaProps = Object.keys(agentTool.inputSchema.properties).sort();
    const descriptorNames = AGENT_OPTIONS.map((option) => option.name).sort();
    expect(descriptorNames).toEqual(schemaProps);
  });

  test("only the multiprovider-only fields feed the strip set", () => {
    expect([...AGENT_MULTIPROVIDER_ONLY_FIELDS]).toEqual(["tier", "provider"]);
  });

  test("does not expose a mode property", () => {
    expect(agentTool.inputSchema.properties).not.toHaveProperty("mode");
  });

  test("exposes worktree and remote isolation modes", () => {
    expect(agentTool.inputSchema.properties.isolation.enum).toEqual(["worktree", "remote"]);
    expect(agentTool.inputSchema.properties.isolation.description).toContain(
      '"remote" launches the agent in a remote cloud environment',
    );
  });
});
