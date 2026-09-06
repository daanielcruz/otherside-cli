import { describe, expect, it } from "bun:test";
import {
  type AgentContext,
  MAX_AGENT_SPAWN_DEPTH,
  withSpawnedAgentScope,
} from "@/engine/agents/agent-context.ts";
import { runForkLoopExternal } from "@/engine/background/subagents/fork/loop.ts";
import { dispatchSkillFork } from "@/engine/background/subagents/fork/spawn.ts";
import {
  agentSpawnDepth,
  isForkChildContext,
  isRootAgentRun,
  nestedForkUnavailableMessage,
  subagentNestingLimitMessage,
} from "@/engine/background/subagents/fork/spawn-depth.ts";
import type { ForkSpec } from "@/engine/background/subagents/fork/types.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

function contextAtDepth(depth: number): AgentContext {
  return {
    agentId: `fork-depth-${depth}`,
    depth,
    parentSessionId: "session-depth-test",
    agentType: "subagent",
    subagentName: "depth-probe",
    sessionAllowedToolPatterns: new Set<string>(),
  };
}

function specWithCtx(ctx: Partial<RequestContext>): ForkSpec {
  return {
    name: "depth-probe",
    body: "",
    allowSet: null,
    prompt: "noop",
    ctx: ctx as RequestContext,
  } as unknown as ForkSpec;
}

describe("subagent nesting ceiling", () => {
  it("refuses to mint a fork when the spawner sits at the cap", async () => {
    await expect(
      withSpawnedAgentScope(contextAtDepth(MAX_AGENT_SPAWN_DEPTH), () =>
        runForkLoopExternal(specWithCtx({ sessionId: "s", cwd: "/tmp" })),
      ),
    ).rejects.toThrow(subagentNestingLimitMessage(MAX_AGENT_SPAWN_DEPTH));
  });

  it("refuses past the cap too, reporting the actual depth", async () => {
    const over = MAX_AGENT_SPAWN_DEPTH + 2;
    await expect(
      withSpawnedAgentScope(contextAtDepth(over), () =>
        runForkLoopExternal(specWithCtx({ sessionId: "s", cwd: "/tmp" })),
      ),
    ).rejects.toThrow(subagentNestingLimitMessage(over));
  });

  it("recognizes only an ownerless, unmarked, non-ALS context as main", () => {
    expect(isRootAgentRun({} as RequestContext)).toBe(true);
    expect(isRootAgentRun({ agentOwnerId: "named-child" } as RequestContext)).toBe(false);
    expect(isRootAgentRun({ isForkChild: true } as RequestContext)).toBe(false);
    expect(
      withSpawnedAgentScope(contextAtDepth(1), () => isRootAgentRun({} as RequestContext)),
    ).toBe(false);
  });

  it("retains the fork-child marker and gives a main-only refusal", () => {
    expect(isForkChildContext({ isForkChild: true } as RequestContext)).toBe(true);
    expect(isForkChildContext({} as RequestContext)).toBe(false);
    expect(nestedForkUnavailableMessage).toBe(
      "Fork is only available from the main agent. Complete your task directly or launch a named agent instead.",
    );
  });

  it("refuses skill-fork dispatch from any owned agent context", async () => {
    const result = await dispatchSkillFork({
      ctx: { agentOwnerId: "named-child" } as RequestContext,
      name: "forked-skill",
      body: "noop",
      prompt: "noop",
      permissionResolver: async () => "deny",
    });

    expect(result).toEqual({ output: nestedForkUnavailableMessage, isError: true });
  });

  it("counts an ownerless main-session spawner as depth zero", () => {
    expect(agentSpawnDepth({} as RequestContext)).toBe(0);
  });

  it("counts a detached background spawner as depth one, not zero", () => {
    expect(agentSpawnDepth({ agentOwnerId: "bg-1" } as RequestContext)).toBe(1);
  });

  it("instructs the model to finish the work itself instead of retrying the spawn", () => {
    const message = subagentNestingLimitMessage(MAX_AGENT_SPAWN_DEPTH);
    expect(message).toContain(`depth ${MAX_AGENT_SPAWN_DEPTH} of ${MAX_AGENT_SPAWN_DEPTH}`);
    expect(message).toContain("Complete this task directly using your tools");
  });
});
