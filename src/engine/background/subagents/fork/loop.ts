import {
  currentSpawnedAgentScope,
  MAX_AGENT_SPAWN_DEPTH,
  withSpawnedAgentScope,
} from "@/engine/agents/agent-context.ts";
import { registerRunningFork } from "@/engine/background/subagents/lifecycle.ts";
import { acquireWorktreeLease, createWorktree } from "@/engine/background/subagents/worktree.ts";
import {
  cancelTaskTree,
  get as getBackgroundTask,
  markOwnerNotificationsConsumed,
  markOwnerNotificationsPromoted,
  taskRunRef,
} from "@/engine/background/tasks/background.ts";
import { clearScope as clearTaskScope } from "@/engine/background/tasks/index.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import { restoreResumedToolOutputArchive } from "@/engine/tool-output-archive/index.ts";
import type { McpServerConfig, McpServerSpec } from "@/kernel/mcp/index.ts";
import { loadNamespacedMcpRuntime } from "@/kernel/mcp/runtime/manager.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { getActiveRewindTurn } from "@/kernel/storage/file-history.ts";
import { buildWorktreeNotice } from "./builder.ts";
import { toMcpDeclaration } from "./declarations.ts";
import { serializeDurableForkSpec, writeDurableForkSpec } from "./durable-spec.ts";
import { taskHooksFromParsed } from "./hooks.ts";
import { runForkLoopInContext } from "./loop-runner.ts";
import { agentSpawnDepth, subagentNestingLimitMessage } from "./spawn-depth.ts";
import { drainAgentSteers } from "./steering.ts";
import type { ForkSpec, SubagentResult } from "./types.ts";

let forkSeq = 0;
const newForkId = (): string => {
  forkSeq = (forkSeq + 1) | 0;
  return `fork_${Date.now().toString(36)}_${forkSeq.toString(36)}`;
};

export async function runForkLoopExternal(spec: ForkSpec): Promise<SubagentResult> {
  return runForkLoop(spec);
}

async function runForkLoop(spec: ForkSpec): Promise<SubagentResult> {
  const { ctx: parentCtx } = spec;
  // Universal nesting ceiling: every spawn path (tool call, workflow bridge,
  // skill fork, resume) funnels through here, so a spawner already at the cap
  // can never mint a deeper fork regardless of which surface asked for it.
  // The planner's early denial is UX; this is the enforcement.
  const spawnerDepth = agentSpawnDepth(parentCtx);
  if (spawnerDepth >= MAX_AGENT_SPAWN_DEPTH) {
    throw new Error(subagentNestingLimitMessage(spawnerDepth));
  }
  const { backgroundController: _parentBgController, ...parentCtxRest } = parentCtx;
  const forkId = spec.forkId ?? newForkId();
  // Every fork accepts steering by default; a caller-provided drainer wins.
  if (spec.pendingUserInputDrainer === undefined) {
    spec = {
      ...spec,
      pendingUserInputDrainer: () => drainAgentSteers(forkId),
    };
  }
  const namespace = `fork:${forkId}`;
  const inlineServers = inlineMcpServersFromSpecs(spec.inlineMcpServers);
  const inlineMcp =
    Object.keys(inlineServers).length > 0
      ? await loadNamespacedMcpRuntime({ namespace, servers: inlineServers })
      : null;
  const setupWarnings = [
    ...(spec.setupWarnings ?? []),
    ...(inlineMcp?.failures ?? []).map(
      (failure) =>
        `agent "${spec.agentId ?? spec.name}" declares MCP server "${failure.server}", which failed to connect: ${failure.error}`,
    ),
  ];
  const scopedTools = [...(spec.scopedTools ?? []), ...(inlineMcp?.handlers ?? [])];
  const scopedToolHandlers =
    scopedTools.length > 0
      ? new Map(scopedTools.map((tool) => [tool.schema.name, tool]))
      : undefined;
  const inlineDeclarations = (inlineMcp?.handlers ?? []).map((handler) =>
    toMcpDeclaration(handler.schema),
  );
  if (spec.allowSet !== null) {
    for (const declaration of inlineDeclarations) spec.allowSet.add(declaration.name);
  }
  const { copyToolOutputArchive, createToolOutputArchive } = await import(
    "@/engine/tool-output-archive/index.ts"
  );
  const resumedArchive =
    spec.initialMessages !== undefined
      ? restoreResumedToolOutputArchive(parentCtx.toolOutputArchive, spec.initialMessages, [])
      : undefined;
  // Freeze the spawning turn so this fork's file mutations snapshot under it, not
  // whatever turn is armed on the shared session when they later run.
  const frozenRewindTurn = parentCtx.rewindTurnId ?? getActiveRewindTurn(parentCtx.sessionId);
  // Agent-definition mode pins the child's permission view unconditionally;
  // the LIVE broker's yolo/accept-edits win per decision inside permission
  // resolution, never as a spawn-time snapshot. Without a definition mode the
  // child continues under the parent's own override (or the live broker).
  const parentAls = currentSpawnedAgentScope();
  const permissionModeOverride = spec.permissionMode ?? parentAls?.permissionModeOverride;
  const ctx: RequestContext = {
    ...parentCtxRest,
    agentId: forkId,
    ...(permissionModeOverride !== undefined ? { permissionMode: permissionModeOverride } : {}),
    bgTaskId:
      (spec.parentToolCallId && parentCtx.childTaskIdMap?.get(spec.parentToolCallId)) ||
      parentCtx.bgTaskId,
    ...(frozenRewindTurn !== undefined ? { rewindTurnId: frozenRewindTurn } : {}),
    subagentLabel: parentCtx.subagentLabel ?? "collab_spawn",
    agentOwnerId: forkId,
    // A spawner that is itself a subagent stamps the child with its own owner id,
    // so a nested request carries both its agent id and its parent's. A top-level
    // spawn (main session, no owner id) leaves this unset and emits no parent id.
    ...(parentCtx.agentOwnerId !== undefined ? { parentAgentOwnerId: parentCtx.agentOwnerId } : {}),
    isForkChild: parentCtx.isForkChild === true || spec.inheritParentTurn === true,
    parentThreadId: parentCtx.parentThreadId ?? parentCtx.sessionId,
    forkAllowSet: spec.allowSet,
    forkDeferredAllow: spec.deferredAllow,
    ...(scopedToolHandlers ? { scopedToolHandlers } : {}),
    taskHooks: taskHooksFromParsed(spec.agentHooks),
    toolOutputArchive:
      resumedArchive ??
      (parentCtx.toolOutputArchive
        ? copyToolOutputArchive(parentCtx.toolOutputArchive)
        : createToolOutputArchive()),
  };
  const parentAgentId = parentAls?.agentId;
  const agentContext = {
    agentId: forkId,
    ...(parentAgentId !== undefined ? { parentAgentId } : {}),
    // Same accessor as the ceiling guard above: a detached background spawner
    // without an ALS context still counts as depth 1, so its children start at
    // 2 instead of restarting the ladder the guard climbs.
    depth: spawnerDepth + 1,
    parentSessionId: parentCtx.parentThreadId ?? parentCtx.sessionId,
    agentType: "subagent" as const,
    subagentName: spec.name,
    // Seeded from the parent fork's own accumulated session grants (if the
    // parent is itself a fork) so a nested spawn keeps what an ancestor fork
    // already earned, without writing back into it (a fresh clone, not a
    // shared reference). The main turn's session grants aren't captured here
    // — they aren't reachable through AgentContext — but still apply live via
    // `sessionAllowPatternsForMatch` in permission-resolution.ts, which layers
    // this set on top of the root session's patterns at match time.
    sessionAllowedToolPatterns: new Set(parentAls?.sessionAllowedToolPatterns ?? []),
    ...(permissionModeOverride !== undefined ? { permissionModeOverride } : {}),
    ...(spec.shouldAvoidPermissionPrompts === true ? { shouldAvoidPermissionPrompts: true } : {}),
  };
  const externalWorktree = spec.worktree ?? null;
  const worktree =
    externalWorktree ??
    (spec.isolation === "worktree"
      ? await createWorktree(ctx.cwd, spec.worktreeKey ?? forkId)
      : null);
  if (spec.isolation === "worktree" && worktree === null) {
    throw new Error("worktree isolation: failed to create or reuse the requested worktree");
  }
  const ownsWorktree = externalWorktree === null && worktree !== null;
  // A self-managed worktree holds a run-lifetime lease so the periodic orphan
  // prune never reclaims it underneath a live agent. An externally-owned
  // worktree (workflow retries) is leased by its owner, not here.
  const worktreeLease =
    ownsWorktree && worktree !== null ? await acquireWorktreeLease(worktree.path) : null;
  let activeSpec: ForkSpec =
    inlineDeclarations.length > 0
      ? {
          ...spec,
          extraDeclarations: [...(spec.extraDeclarations ?? []), ...inlineDeclarations],
        }
      : spec;
  if (worktree) {
    const parentCwd = ctx.cwd;
    // Keep the outermost project key across nested worktree rewrites.
    ctx.originalCwd = ctx.originalCwd ?? parentCwd;
    ctx.cwd = worktree.path;
    ctx.worktreeRoot = worktree.path;
    if (spec.inheritParentTurn === true && spec.initialMessages) {
      let noticeText = buildWorktreeNotice(parentCwd, worktree.path);
      if (worktree.warning) {
        noticeText += `\n\nWarning: ${worktree.warning}`;
      }
      activeSpec = {
        ...activeSpec,
        initialMessages: [
          ...spec.initialMessages,
          {
            role: "user",
            content: [{ type: "text", text: noticeText }],
          },
        ],
      };
    }
  }
  if (activeSpec.preserveDurableSpec !== true) {
    const durableRef = {
      cwd: ctx.originalCwd ?? ctx.cwd,
      sessionId: ctx.sessionId,
      forkId,
    };
    await writeDurableForkSpec(durableRef, serializeDurableForkSpec(activeSpec, forkId, ctx));
  }

  const releaseNotificationOwner = emitQueue.registerOwner(forkId, {
    onInventoryConsumed: (replayKeys) => markOwnerNotificationsConsumed(forkId, replayKeys),
    onOwnerRelease: ({ promotedReplayKeys }) =>
      markOwnerNotificationsPromoted(forkId, promotedReplayKeys),
  });
  let releaseAddress = (): void => {};
  let result: SubagentResult | undefined;
  try {
    releaseAddress = registerRunningFork(forkId, spec.name, activeSpec, ctx);
    result = await withSpawnedAgentScope(agentContext, () =>
      runForkLoopInContext(activeSpec, forkId, ctx),
    );
    return result;
  } finally {
    if (ctx.abortSignal?.aborted === true && ctx.bgTaskId !== undefined) {
      const task = getBackgroundTask(ctx.bgTaskId);
      if (task !== undefined) {
        cancelTaskTree(taskRunRef(task), {
          reason: "aborted",
          suppressRootNotification: true,
        });
      }
    }
    releaseAddress();
    releaseNotificationOwner();
    if (result && setupWarnings.length > 0) {
      result.setupWarnings = setupWarnings;
    }
    if (inlineMcp) {
      // Teardown of the fork's private client lands after the result is settled
      // and cannot change it, so a failure here is swallowed.
      try {
        await inlineMcp.close();
      } catch {}
    }
    if (ownsWorktree && worktree) {
      // Release the lease before cleanup so the fail-closed guard doesn't block
      // our own removal, then clean up (preserved if the agent left changes).
      if (worktreeLease) await worktreeLease.release();
      const { deleted } = await worktree.cleanup();
      if (result) {
        result.worktreePath = worktree.path;
        result.worktreeBranch = worktree.branch;
        result.worktreeDeleted = deleted;
        if (worktree.warning) {
          result.worktreeWarning = worktree.warning;
        }
      }
    } else if (externalWorktree && result) {
      // The owner cleans up after the durable result; only surface identity here.
      result.worktreePath = externalWorktree.path;
      result.worktreeBranch = externalWorktree.branch;
      if (externalWorktree.warning) {
        result.worktreeWarning = externalWorktree.warning;
      }
    }
    // The agent's private task list dies with the agent.
    clearTaskScope(forkId);
    // Steers left undrained (queued after the loop's last boundary) are NOT
    // cleared: their echo is already persisted in the sidechain transcript, so
    // the next resume rebuilds them into the conversation — resume clears the
    // queue to avoid delivering the same content twice.
  }
}

function inlineMcpServersFromSpecs(
  specs: readonly McpServerSpec[] | null | undefined,
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  for (const spec of specs ?? []) {
    if (typeof spec === "string") continue;
    const [entry] = Object.entries(spec);
    if (!entry) continue;
    const [name, config] = entry;
    servers[name] = config;
  }
  return servers;
}
