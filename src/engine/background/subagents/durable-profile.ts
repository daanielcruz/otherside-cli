import { get as getAgentDef } from "@/engine/agents/registry.ts";
import type { BackgroundTask } from "@/engine/background/tasks/background.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { mcpDeclarationsForDef } from "./fork/declarations.ts";
import type { DurableForkSpecV1 } from "./fork/durable-spec.ts";
import {
  computeAllowedAgentTypes,
  resolveAllowSetForFork,
  resolveDefaultAllowSetForFork,
} from "./fork/profile.ts";
import { skillMessagesForDef } from "./fork/skill-messages.ts";
import type { ForkSpec } from "./fork/types.ts";
import { snapshotMessages } from "./resume-messages.ts";

type ForkLifecycleState = "running" | "resuming" | "finished";

export interface ForkResumeProfile {
  forkId: string;
  name: string;
  spec: ForkSpec;
  ctx: RequestContext;
  baseMessages?: Message[];
  state: ForkLifecycleState;
  task?: BackgroundTask;
}

export function profileFromDurableSpec(
  durable: DurableForkSpecV1,
  requestCtx: RequestContext,
): ForkResumeProfile | null {
  const def = durable.kind === "subagent" ? getAgentDef(durable.agentId) : undefined;
  const allowSet =
    durable.allowSet !== null
      ? new Set(durable.allowSet)
      : durable.kind === "fork"
        ? null
        : def !== undefined
          ? resolveAllowSetForFork(def, "subagent", requestCtx)
          : resolveDefaultAllowSetForFork("subagent", requestCtx);
  let definitionFields: Partial<ForkSpec>;
  if (def === undefined) {
    definitionFields = { inheritParentTurn: durable.kind === "fork" };
  } else {
    const skills = skillMessagesForDef(def);
    definitionFields = {
      extraDeclarations: mcpDeclarationsForDef(def, allowSet),
      skillMessages: skills.messages,
      ...(skills.warnings.length > 0 ? { setupWarnings: skills.warnings } : {}),
      agentHooks: def.hooks ?? null,
      allowedAgentTypes: computeAllowedAgentTypes(def),
      allowNestedAgents: true,
      shouldAvoidPermissionPrompts: true,
      inlineMcpServers: def.mcpServers,
      ...(def.maxTurns !== undefined ? { maxTurns: def.maxTurns } : {}),
    };
  }
  // A durable sidecar records the spawn-time mode even when it was inherited.
  // Only an agent definition's explicit mode is a child override; inherited
  // modes must be refreshed from the caller's live broker on every rebuild.
  // Sidecars from before the provenance field deliberately take this safer
  // inherited path.
  const permissionMode =
    durable.permissionModeIsDefinitionPinned === true
      ? durable.permissionMode
      : (requestCtx.broker?.read().permissionMode ?? requestCtx.permissionMode);
  const ctx: RequestContext = {
    ...requestCtx,
    provider: durable.provider as RequestContext["provider"],
    model: durable.model,
    effort: durable.effort,
    permissionMode,
    cwd: durable.cwd,
    sessionId: durable.sessionId,
    bgTaskId: durable.forkId,
    ...(durable.originalCwd !== undefined ? { originalCwd: durable.originalCwd } : {}),
    ...(durable.worktreeRoot !== undefined ? { worktreeRoot: durable.worktreeRoot } : {}),
  };
  const spec: ForkSpec = {
    ctx,
    name: durable.name ?? durable.agentId,
    body: def?.body ?? durable.body ?? "",
    allowSet,
    prompt: durable.prompt,
    agentId: durable.agentId,
    ...(durable.description !== undefined ? { description: durable.description } : {}),
    ...(durable.parentToolCallId !== undefined
      ? { parentToolCallId: durable.parentToolCallId }
      : {}),
    ...(durable.permissionModeIsDefinitionPinned === true
      ? {
          permissionMode: durable.permissionMode,
          permissionModeIsDefinitionPinned: true,
        }
      : {}),
    ...(durable.isolation !== undefined ? { isolation: durable.isolation } : {}),
    ...(durable.deferredAllow !== undefined
      ? { deferredAllow: new Set(durable.deferredAllow) }
      : {}),
    ...(durable.initialMessages !== undefined
      ? { initialMessages: snapshotMessages(durable.initialMessages) }
      : {}),
    ...definitionFields,
  };
  const now = Date.now();
  const task: BackgroundTask = {
    id: durable.forkId,
    kind: "agent",
    parentToolCallId: durable.parentToolCallId ?? durable.forkId,
    agentName: durable.name ?? durable.agentId,
    agentId: durable.agentId,
    ...(durable.description !== undefined ? { description: durable.description } : {}),
    prompt: durable.prompt,
    provider: durable.provider as RequestContext["provider"],
    model: durable.model,
    ...(durable.effort !== null ? { effort: durable.effort } : {}),
    cwd: durable.originalCwd ?? durable.cwd,
    sessionId: durable.sessionId,
    runGeneration: 0,
    runToken: `${durable.forkId}:durable`,
    lifecycleMode: "detached",
    terminalNotification: "main",
    status: "completed",
    startedAt: now,
    endedAt: now,
    isBackgrounded: true,
    forkId: durable.forkId,
    actions: [],
    assistantText: "",
    shellOutput: "",
    inputTokens: 0,
    outputTokens: 0,
    notified: true,
  };
  return {
    forkId: durable.forkId,
    name: durable.name ?? durable.agentId,
    spec,
    ctx,
    state: "finished",
    task,
    ...(durable.initialMessages !== undefined
      ? { baseMessages: snapshotMessages(durable.initialMessages) ?? [] }
      : {}),
  };
}
