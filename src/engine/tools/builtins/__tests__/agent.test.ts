import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type AgentContext, withSpawnedAgentScope } from "@/engine/agents/agent-context.ts";
import type {
  ForkInvocation,
  SubagentInvocation,
} from "@/engine/background/subagents/dispatcher.ts";
import * as realDispatcher from "@/engine/background/subagents/dispatcher.ts";
import { buildAgentInputSchema } from "@/engine/tools/dynamic/Agent.ts";
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
    const result = await withSpawnedAgentScope(childAgentContext, () =>
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

  test.each([
    "default",
    "feudalism",
  ] as const)("forwards a concrete pair on a %s fork", async (orchestrationMode) => {
    await Agent.run(
      makeCall({
        description: "test",
        prompt: "do it",
        subagent_type: "fork",
        provider: "codex",
        model: "gpt-5.5",
      }),
      { ...baseCtx, orchestrationMode },
    );

    expect(dispatchFork).toHaveBeenCalledTimes(1);
    const args = dispatchFork.mock.calls[0]?.[0];
    if (!args) throw new Error("expected dispatchFork call");
    expect(args.route).toEqual({ provider: "codex", model: "gpt-5.5" });
    expect(dispatchSubagent).toHaveBeenCalledTimes(0);
  });

  test("rejects a concrete pair on a disabled fork", async () => {
    const result = await Agent.run(
      makeCall({
        description: "test",
        prompt: "do it",
        subagent_type: "fork",
        provider: "codex",
        model: "gpt-5.5",
      }),
      { ...baseCtx, orchestrationMode: "disabled" },
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("`provider` and `tier` are unavailable");
    expect(dispatchFork).toHaveBeenCalledTimes(0);
    expect(dispatchSubagent).toHaveBeenCalledTimes(0);
  });

  test("forwards the background task id without a permission override", async () => {
    await Agent.run(
      makeCall({
        description: "test",
        prompt: "do it",
      }),
      { ...baseCtx, bgTaskId: "agent-task-id" },
    );

    const args = dispatchSubagent.mock.calls[0]?.[0];
    if (!args) throw new Error("expected dispatchSubagent call");
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

  test("folds definition setup warnings into the result above the worktree trailer", async () => {
    dispatchSubagent.mockImplementationOnce(() =>
      Promise.resolve({
        output: "done",
        isError: false,
        setupWarnings: [
          'agent "auditor" declares skill "missing", which is not loaded — skipped',
          'agent "auditor" declares MCP server "slack", which failed to connect: timeout',
        ],
        worktreePath: "/tmp/wt",
        worktreeBranch: "agent/auditor",
        worktreeDeleted: true,
      }),
    );

    const result = await Agent.run(makeCall({ description: "test", prompt: "do it" }), baseCtx);

    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe(
      [
        "done",
        'Warning: agent "auditor" declares skill "missing", which is not loaded — skipped',
        'Warning: agent "auditor" declares MCP server "slack", which failed to connect: timeout',
        "worktree: /tmp/wt (branch agent/auditor) removed (unchanged)",
      ].join("\n"),
    );
  });

  test("leaves the result untouched when no setup warnings are reported", async () => {
    const result = await Agent.run(makeCall({ description: "test", prompt: "do it" }), baseCtx);
    expect(result.content).toBe("ok");
  });

  // Addressing is id-only: a name in the input is not a schema field, so it is
  // ignored rather than validated, and never reaches the dispatch.
  test("ignores a name field in the input", async () => {
    await Agent.run(makeCall({ description: "test", prompt: "do it", name: "worker-1" }), baseCtx);
    const args = dispatchSubagent.mock.calls[0]?.[0];
    if (!args) throw new Error("expected dispatchSubagent call");
    expect(args).not.toHaveProperty("name");
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
    expect([...orchestrationModeForAgentFields("feudalism")]).toEqual([]);
  });

  test("exposes literal fork pins without a roster in feudalism", () => {
    const schema = buildAgentInputSchema("anthropic", "feudalism");
    const properties = schema.properties as Record<string, { description?: string }>;

    expect(properties.model?.description).toContain("subagent_type");
    expect(properties.provider?.description).toContain("subagent_type");
    expect(properties.model?.description).not.toContain("gpt-5.5");
    expect(properties.provider?.description).not.toContain("codex");
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
