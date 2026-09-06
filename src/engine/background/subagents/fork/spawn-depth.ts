import { currentSpawnedAgentScope, MAX_AGENT_SPAWN_DEPTH } from "@/engine/agents/agent-context.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export function agentSpawnDepth(ctx: RequestContext): number {
  return currentSpawnedAgentScope()?.depth ?? (ctx.agentOwnerId !== undefined ? 1 : 0);
}

export function agentSpawnDepthFromContext(): number {
  return currentSpawnedAgentScope()?.depth ?? 0;
}

export function isForkChildContext(ctx: RequestContext): boolean {
  return ctx.isForkChild === true;
}

export function isRootAgentRun(ctx: RequestContext): boolean {
  return (
    ctx.agentOwnerId === undefined &&
    ctx.isForkChild !== true &&
    currentSpawnedAgentScope() === undefined
  );
}

export const nestedForkUnavailableMessage =
  "Fork is only available from the main agent. Complete your task directly or launch a named agent instead.";

// Model-facing refusal for a spawn at the nesting ceiling. The instruction to
// finish the work directly matters: without it the model tends to retry the
// spawn instead of doing the task itself.
export function subagentNestingLimitMessage(depth: number): string {
  return `Subagent nesting limit reached (depth ${depth} of ${MAX_AGENT_SPAWN_DEPTH}). Complete this task directly using your tools instead of spawning another agent.`;
}
