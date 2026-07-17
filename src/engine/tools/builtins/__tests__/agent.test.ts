import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type AgentContext, runWithAgentContext } from "@/engine/agents/agent-context.ts";
import type {
  ForkInvocation,
  SubagentInvocation,
} from "@/engine/background/subagents/dispatcher.ts";
import * as realDispatcher from "@/engine/background/subagents/dispatcher.ts";
import {
  AGENT_OPTIONS,
  orchestrationModeForAgentFields,
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
  orchestrationMode: "feudalism",
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
        tier: "daimyo",
      }),
      baseCtx,
    );

    expect(dispatchSubagent).toHaveBeenCalledTimes(1);
    const args = dispatchSubagent.mock.calls[0]?.[0];
    if (!args) throw new Error("expected dispatchSubagent call");
    expect(args.subagentType).toBe("explore");
    expect(args.tierOverride).toBe("daimyo");
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
    await Agent.run(makeCall({ description: "test", prompt: "do it", tier: "daimyo" }), baseCtx);

    expect(dispatchFork).toHaveBeenCalledTimes(0);
    expect(dispatchSubagent).toHaveBeenCalledTimes(1);
    const args = dispatchSubagent.mock.calls[0]?.[0];
    if (!args) throw new Error("expected dispatchSubagent call");
    expect(args.subagentType).toBe("general-purpose");
    expect(args.tierOverride).toBe("daimyo");
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
      makeCall({ description: "test", prompt: "do it", subagent_type: "fork", tier: "daimyo" }),
      baseCtx,
    );

    expect(dispatchFork).toHaveBeenCalledTimes(0);
    expect(dispatchSubagent).toHaveBeenCalledTimes(0);
    expect(result.is_error).toBe(true);
  });

  test("rejects a concrete model on an Experimental fork", async () => {
    const result = await Agent.run(
      makeCall({
        description: "test",
        prompt: "do it",
        subagent_type: "fork",
        model: "claude-haiku-4-5",
      }),
      baseCtx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("concrete `provider`/`model` pins are unavailable");
    expect(dispatchFork).toHaveBeenCalledTimes(0);
    expect(dispatchSubagent).toHaveBeenCalledTimes(0);
  });

  test("forwards name and the background task id without a permission override", async () => {
    await Agent.run(
      makeCall({
        description: "test",
        prompt: "do it",
        name: "worker-1",
      }),
      { ...baseCtx, bgTaskId: "agent-task-id" },
    );

    const args = dispatchSubagent.mock.calls[0]?.[0];
    if (!args) throw new Error("expected dispatchSubagent call");
    expect(args.name).toBe("worker-1");
    expect(args.permissionMode).toBeUndefined();
    expect(args.forkId).toBe("agent-task-id");
  });

  test("strips injected cwd before validation and dispatch", async () => {
    const coerced = Agent.coerceInput?.({
      description: "test",
      prompt: "do it",
      cwd: "/tmp/agent-cwd",
      isolation: "worktree",
    });
    expect(coerced).toEqual({
      description: "test",
      prompt: "do it",
      isolation: "worktree",
    });

    const result = await Agent.run(makeCall(coerced as Record<string, unknown>), baseCtx);
    expect(result.is_error).toBeUndefined();
    const args = dispatchSubagent.mock.calls[0]?.[0];
    if (!args) throw new Error("expected dispatchSubagent call");
    expect(args).not.toHaveProperty("cwd");
    expect(args.isolation).toBe("worktree");
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

  test("mode-specific fields expose the canonical Agent boundary", () => {
    expect([...orchestrationModeForAgentFields("disabled")]).toEqual(["tier", "provider"]);
    expect([...orchestrationModeForAgentFields("default")]).toEqual(["tier"]);
    expect([...orchestrationModeForAgentFields("feudalism")]).toEqual(["model", "provider"]);
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
