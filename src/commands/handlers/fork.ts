import type { SlashCommand } from "@/commands/catalog.ts";
import type { SlashContext, SlashResult } from "@/commands/types.ts";
import type { PermissionResolver } from "@/engine/agents/agent-context.ts";
import {
  formatForkSuccessFeedback,
  spawnForkFromDirective,
} from "@/engine/background/subagents/fork/spawn-from-directive.ts";
import { resolvePermission } from "@/engine/queue/runtime/permission-resolution.ts";
import { makeRequestContext } from "@/engine/queue/runtime/request-context.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export const FORK_USAGE_FEEDBACK = "Usage: /fork \\<directive\\>";
export const FORK_NO_TURN_FEEDBACK = "Cannot fork before the first conversation turn";

function buildParentContext(ctx: SlashContext): RequestContext {
  return {
    ...makeRequestContext(ctx.agent.deps),
    parentMessages: [...ctx.session.messages],
  };
}

function permissionResolverFor(ctx: SlashContext): PermissionResolver {
  return (toolCall) =>
    resolvePermission(
      {
        agentDeps: ctx.agent.deps,
        injections: ctx.agent.injections,
        sessionAllowedToolPatterns: ctx.agent.sessionAllowedToolPatterns,
      },
      toolCall,
    );
}

export async function handleFork(
  cmd: SlashCommand,
  args: string,
  ctx: SlashContext,
): Promise<SlashResult> {
  const directive = args.trim();
  if (directive.length === 0) {
    return { kind: "instant", command: cmd, feedback: FORK_USAGE_FEEDBACK };
  }

  try {
    const parentCtx = buildParentContext(ctx);
    const result = spawnForkFromDirective(directive, parentCtx, permissionResolverFor(ctx));
    if (!result) {
      return { kind: "instant", command: cmd, feedback: FORK_NO_TURN_FEEDBACK };
    }
    return {
      kind: "instant",
      command: cmd,
      feedback: formatForkSuccessFeedback(result),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "instant",
      command: cmd,
      feedback: `Failed to fork: ${message}`,
    };
  }
}
