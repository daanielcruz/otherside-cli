import { recordCodexRawReplayDiagnostic } from "@/devtools/codex-raw-stream.ts";
import { runWithPermissionResolver } from "@/engine/agents/agent-context.ts";
import { get as getAgent, type SubagentDef } from "@/engine/agents/registry.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { buildForkedMessages } from "./builder.ts";
import { mcpDeclarationsForDef } from "./declarations.ts";
import { withLiveBrokerEffort } from "./live-effort.ts";
import { runForkLoopExternal } from "./loop.ts";
import {
  computeAllowedAgentTypes,
  resolveAllowSetForFork,
  resolveDefaultAllowSetForFork,
} from "./profile.ts";
import {
  quotaRerouteForInvocation,
  resolveSubagentRoutingForDispatch,
  resolveToolTierQuotaReroute,
} from "./routing.ts";
import { skillMessagesForDef } from "./skill-messages.ts";
import { isMainAgentContext, nestedForkUnavailableMessage } from "./spawn-depth.ts";
import type {
  ForkInvocation,
  ForkSpec,
  SkillForkInvocation,
  SubagentInvocation,
  SubagentResult,
} from "./types.ts";

// A definition's `background: true` detaches the launch even when the env
// kill-switch turns the auto-background default off. Exported for direct
// regression coverage.
export function subagentLaunchDetaches(
  invocation: SubagentInvocation,
  def: Pick<SubagentDef, "background">,
): boolean {
  return invocation.runInBackground === true || def.background === true;
}

// Only detached named subagents lack a parent turn that can answer a prompt.
// Foreground launches must let otherwise-unruled asks bubble to the user.
export function shouldAvoidPermissionPromptsForSubagent(
  invocation: SubagentInvocation,
  def: Pick<SubagentDef, "background">,
): boolean {
  return subagentLaunchDetaches(invocation, def);
}

export async function dispatchSubagent(
  invocation: SubagentInvocation,
  ctx: RequestContext,
): Promise<SubagentResult> {
  const def = getAgent(invocation.subagentType);
  if (!def) {
    return {
      output: `unknown subagent_type: ${invocation.subagentType}`,
      isError: true,
    };
  }
  const baseCtx = withLiveBrokerEffort(ctx);
  recordCodexRawReplayDiagnostic({
    event: "agent_route_start",
    subagentType: invocation.subagentType,
    sessionId: ctx.sessionId,
  });
  const resolvedOverride = await resolveSubagentRoutingForDispatch(baseCtx, def, invocation);
  recordCodexRawReplayDiagnostic({
    event: "agent_route_end",
    subagentType: invocation.subagentType,
    ok: resolvedOverride.ok,
    ...(resolvedOverride.ok
      ? { provider: resolvedOverride.ctx.provider, model: resolvedOverride.ctx.model }
      : { error: resolvedOverride.error }),
    sessionId: ctx.sessionId,
  });
  if (!resolvedOverride.ok) {
    return { output: resolvedOverride.error, isError: true };
  }
  if (resolvedOverride.routingNotice !== undefined) {
    ctx.progressSink?.({ kind: "text", text: resolvedOverride.routingNotice });
  }
  const addTierClampNotice = (result: SubagentResult): SubagentResult =>
    resolvedOverride.tierClampNotice === undefined
      ? result
      : {
          ...result,
          output: `${resolvedOverride.tierClampNotice}\n\n${result.output}`,
        };
  const allowedAgentTypes = computeAllowedAgentTypes(def);
  const body = def.body.trim().length > 0 ? def.body : `You are the ${def.name} subagent.`;
  const detaches = subagentLaunchDetaches(invocation, def);
  const shouldAvoidPermissionPrompts = shouldAvoidPermissionPromptsForSubagent(invocation, def);
  if (detaches) {
    ctx.backgroundController?.signal();
  }

  const runResolved = (nextCtx: RequestContext): Promise<SubagentResult> => {
    const subCtx: RequestContext = {
      ...nextCtx,
      suppressThinkingSummary: true,
    };
    const allowSet = resolveAllowSetForFork(def, "subagent", subCtx);
    const extraDeclarations = mcpDeclarationsForDef(def, allowSet);
    const skillMessages = skillMessagesForDef(def);
    recordCodexRawReplayDiagnostic({
      event: "agent_loop_start",
      subagentType: invocation.subagentType,
      provider: subCtx.provider,
      model: subCtx.model,
      sessionId: subCtx.sessionId,
    });
    return runForkLoopExternal({
      ctx: subCtx,
      name: invocation.name ?? def.name,
      body,
      allowSet,
      prompt: invocation.prompt,
      description: invocation.description,
      sink: ctx.eventSink,
      parentToolCallId: invocation.parentToolCallId,
      agentId: invocation.subagentType,
      ...(invocation.forkId !== undefined ? { forkId: invocation.forkId } : {}),
      extraDeclarations,
      skillMessages,
      agentHooks: def.hooks ?? null,
      allowedAgentTypes,
      allowNestedAgents: true,
      ...(shouldAvoidPermissionPrompts ? { shouldAvoidPermissionPrompts: true } : {}),
      inlineMcpServers: def.mcpServers,
      ...(def.maxTurns !== undefined ? { maxTurns: def.maxTurns } : {}),
      ...((invocation.permissionMode ?? def.permissionMode)
        ? { permissionMode: invocation.permissionMode ?? def.permissionMode }
        : {}),
      ...(invocation.permissionMode === undefined && def.permissionMode !== undefined
        ? { permissionModeIsDefinitionPinned: true }
        : {}),
      ...(invocation.isolation !== undefined ? { isolation: invocation.isolation } : {}),
    });
  };

  const result = await runResolved(resolvedOverride.ctx);
  const reroute = quotaRerouteForInvocation(resolvedOverride.ctx, invocation, result);
  if (reroute === undefined) return addTierClampNotice(result);
  const rerouted = resolveToolTierQuotaReroute(
    resolvedOverride.ctx,
    reroute.tier,
    reroute.provider,
  );
  if (!rerouted.ok) {
    // Only the disabled-fallback refusal is surfaced; a resolution failure with
    // fallback enabled keeps the original quota output untouched, as before.
    if (rerouted.gated === true) {
      return addTierClampNotice({ ...result, output: `${result.output}\n\n${rerouted.error}` });
    }
    return addTierClampNotice(result);
  }
  return addTierClampNotice(await runResolved(rerouted.ctx));
}

export async function dispatchSkillFork(args: SkillForkInvocation): Promise<SubagentResult> {
  if (!isMainAgentContext(args.ctx)) {
    return { output: nestedForkUnavailableMessage, isError: true };
  }
  return runWithPermissionResolver(args.permissionResolver, () =>
    runForkLoopExternal({
      ctx: { ...args.ctx, suppressThinkingSummary: true },
      name: args.name,
      body: args.body,
      allowSet: resolveDefaultAllowSetForFork("subagent", args.ctx),
      prompt: args.prompt,
      sink: args.ctx.eventSink,
      parentToolCallId: args.parentToolCallId,
      agentId: args.name,
    }),
  );
}

export async function dispatchFork(
  invocation: ForkInvocation,
  ctx: RequestContext,
): Promise<SubagentResult> {
  if (!isMainAgentContext(ctx)) {
    return { output: nestedForkUnavailableMessage, isError: true };
  }
  const parent: readonly import("@/kernel/std/types/message.ts").Message[] =
    ctx.parentMessages ?? [];
  if (parent.length === 0) {
    return {
      output:
        "fork unavailable: parent context not threaded. Provide a `subagent_type` to spawn a fresh agent instead.",
      isError: true,
    };
  }
  if (invocation.runInBackground === true) {
    ctx.backgroundController?.signal();
  }
  return runForkLoopExternal(buildForkSpec(invocation, ctx, parent));
}

// Pure spec construction, split out from dispatchFork so the
// shouldAvoidPermissionPrompts omission (AGENT-PERM-002) is directly
// unit-testable without exercising runForkLoopExternal.
export function buildForkSpec(
  invocation: ForkInvocation,
  ctx: RequestContext,
  parent: readonly import("@/kernel/std/types/message.ts").Message[],
): ForkSpec {
  const initialMessages = buildForkedMessages(invocation.directive, parent);
  const forkName = invocation.name && invocation.name.length > 0 ? invocation.name : "fork";
  const forkCtx = withLiveBrokerEffort(ctx);
  return {
    ctx: {
      ...forkCtx,
      suppressThinkingSummary: true,
    },
    name: forkName,
    body: "",
    allowSet: null,
    prompt: invocation.directive,
    ...(invocation.description !== undefined ? { description: invocation.description } : {}),
    sink: ctx.eventSink,
    parentToolCallId: invocation.parentToolCallId,
    agentId: forkName,
    ...(invocation.forkId !== undefined ? { forkId: invocation.forkId } : {}),
    initialMessages,
    inheritParentTurn: true,
    // Forks always keep a parent turn that can answer a prompt (see
    // fork/types.ts's `shouldAvoidPermissionPrompts` doc), so backgrounding a
    // fork only detaches its UI — it must still bubble asks rather than
    // auto-deny at permission-resolution.ts, using the `bubble`
    // FORK_AGENT permission mode.
    ...(invocation.permissionMode !== undefined
      ? { permissionMode: invocation.permissionMode }
      : {}),
    ...(invocation.isolation !== undefined ? { isolation: invocation.isolation } : {}),
  };
}
