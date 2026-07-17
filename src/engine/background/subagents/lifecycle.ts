import { existsSync } from "node:fs";
import { registerAgent } from "@/engine/agents/inbox.ts";
import { get as getAgentDef } from "@/engine/agents/registry.ts";
import {
  addUsage,
  appendAction,
  appendAssistantText,
  type BackgroundTask,
  cancelTaskTree,
  completeAction,
  completeTaskForRun,
  discardAssistantText,
  failAction,
  get as getBackgroundTask,
  markBackgrounded,
  reopenTask,
  restoreTaskForResume,
  setModel,
  setTaskOwnerForRun,
  setUsageSnapshot,
  subscribeCompletion,
  type TaskRunRef,
  taskRunRef,
} from "@/engine/background/tasks/background.ts";
import * as bgControllers from "@/engine/background/tasks/background-controllers.ts";
import { publish } from "@/engine/background/tasks/bus.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import { previewArgs } from "@/engine/queue/runtime/args-preview.ts";
import { appendAgentRecordRaw } from "@/engine/session/append.ts";
import { nowIso } from "@/engine/session/record/index.ts";
import { loadSubagentTranscript } from "@/engine/session/transcript/subagent-transcript.ts";
import { sessionRecordsToMessages } from "@/engine/session/transcript/to-messages.ts";
import { clearReadStateForScope } from "@/engine/tools/builtins/read/state.ts";
import { sanitizeMessages } from "@/engine/translator/sanitize.ts";
import { clearSessionHooks } from "@/kernel/hooks/session-registry.ts";
import { isAbortError } from "@/kernel/std/stream/abort.ts";
import type { ForkEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { mcpDeclarationsForDef } from "./fork/declarations.ts";
import {
  type DurableForkSpecV1,
  isDurableForkStopped,
  markDurableForkStopped,
  readDurableForkSpec,
} from "./fork/durable-spec.ts";
import { runForkLoopExternal } from "./fork/loop.ts";
import {
  computeAllowedAgentTypes,
  resolveAllowSetForFork,
  resolveDefaultAllowSetForFork,
} from "./fork/profile.ts";
import { skillMessagesForDef } from "./fork/skill-messages.ts";
import { drainAgentSteers, queueAgentSteer } from "./fork/steering.ts";
import type { ForkSpec } from "./fork/types.ts";
import { acquireResumedWorktreeLease } from "./worktree.ts";

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

export type ForkMessageFailure =
  | "unknown_agent"
  | "not_resumable"
  | "stopped_by_user"
  | "already_running";

export type ForkMessageResult =
  | { delivered: true; agentId: string; resumed: boolean }
  | { delivered: false; code: ForkMessageFailure; reason: string };

type ForkProfileResolution =
  | { ok: true; profile: ForkResumeProfile }
  | { ok: false; code: "unknown_agent" | "stopped_by_user"; reason: string };

const profiles = new Map<string, ForkResumeProfile>();
const idByName = new Map<string, string>();

function snapshotMessages(messages: Message[] | undefined): Message[] | undefined {
  return messages?.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((block) => ({ ...block }))
      : message.content,
  }));
}

export function registerRunningFork(
  forkId: string,
  name: string,
  spec: ForkSpec,
  ctx: RequestContext,
): () => void {
  const existing = profiles.get(forkId);
  const preserveResumeProfile = spec.preserveDurableSpec === true && existing !== undefined;
  let baseMessages = existing?.baseMessages;
  if (!preserveResumeProfile && baseMessages === undefined && spec.initialMessages !== undefined) {
    baseMessages = snapshotMessages(spec.initialMessages);
  }
  const task = getBackgroundTask(forkId) ?? existing?.task;
  const profile: ForkResumeProfile = {
    forkId,
    name,
    spec: preserveResumeProfile && existing ? existing.spec : spec,
    ctx: preserveResumeProfile && existing ? existing.ctx : ctx,
    state: "running",
    ...(baseMessages !== undefined ? { baseMessages } : {}),
    ...(task !== undefined ? { task } : {}),
  };
  profiles.set(forkId, profile);
  const registeredName = idByName.get(name);
  const nameHolder = registeredName === undefined ? undefined : profiles.get(registeredName);
  // A name is claimable only when nobody holds it, this fork already holds it,
  // or the current holder has finished. A finished agent may lose its alias to a
  // new claimant — resume by id still reaches it. A running/resuming holder keeps
  // its name: the new fork registers without the alias and idByName is untouched,
  // so resume routing for the live holder stays intact.
  const canClaimName =
    registeredName === forkId || nameHolder === undefined || nameHolder.state === "finished";
  if (canClaimName) idByName.set(name, forkId);
  const releaseInbox = registerAgent(forkId, canClaimName ? name : undefined, (message) => {
    // A fork whose stop already fired (user cancel) must not swallow the message
    // on the fast path: reject it so the inbox reports the delivery failed and
    // SendMessage falls through to the resume path, which returns the truthful
    // stopped_by_user outcome instead of silently dropping the steer.
    if (ctx.abortSignal?.aborted === true || getBackgroundTask(forkId)?.stoppedByUser === true) {
      throw new Error(`agent ${forkId} is stopping and cannot accept messages`);
    }
    const text =
      message.replyTo === undefined
        ? message.message
        : `[Reply to ${message.replyTo}]\n${message.message}`;
    queueAgentSteer(forkId, {
      text,
      blocks: [{ type: "text", text }],
    });
  });
  return () => {
    const current = profiles.get(forkId);
    if (current !== profile) return;
    try {
      releaseInbox();
    } catch {}
    if (spec.agentHooks) {
      try {
        clearSessionHooks(forkId);
      } catch {}
    }
    try {
      clearReadStateForScope(forkId);
    } catch {}
    try {
      profiles.delete(forkId);
    } catch {}
  };
}

function resolveProfile(to: string): ForkProfileResolution {
  const direct = profiles.get(to);
  if (direct) return { ok: true, profile: direct };
  const id = idByName.get(to);
  const profile = id === undefined ? undefined : profiles.get(id);
  if (profile) return { ok: true, profile };
  return {
    ok: false,
    code: "unknown_agent",
    reason: `No agent found for recipient "${to}".`,
  };
}

export async function resolveForkProfileForResume(
  to: string,
  requestCtx: RequestContext | undefined,
): Promise<ForkProfileResolution> {
  const resolved = resolveProfile(to);
  if (resolved.ok) return resolved;
  const forkId = idByName.get(to) ?? to;
  const task = getBackgroundTask(forkId);
  if (task?.stoppedByUser === true) {
    return {
      ok: false,
      code: "stopped_by_user",
      reason: `Agent ${forkId} was halted by the user, so it will not resume. Consider its work cancelled, and start a new agent only when the user explicitly requests one.`,
    };
  }
  const cwd = requestCtx?.originalCwd ?? requestCtx?.cwd ?? task?.cwd;
  const sessionId = requestCtx?.sessionId ?? task?.sessionId;
  if (cwd === undefined || sessionId === undefined) return resolved;
  const ref = { cwd, sessionId, forkId };
  if (isDurableForkStopped(ref)) {
    return {
      ok: false,
      code: "stopped_by_user",
      reason: `Agent ${to} was halted by the user, so it will not resume. Consider its work cancelled, and start a new agent only when the user explicitly requests one.`,
    };
  }
  const durable = await readDurableForkSpec(ref);
  if (durable === null || durable.forkId !== forkId) return resolved;
  const resumeCtx: RequestContext =
    requestCtx ??
    ({
      provider: durable.provider as RequestContext["provider"],
      model: durable.model,
      effort: durable.effort,
      permissionMode: durable.permissionMode,
      cwd: durable.cwd,
      sessionId: durable.sessionId,
      ...(durable.originalCwd !== undefined ? { originalCwd: durable.originalCwd } : {}),
      ...(durable.worktreeRoot !== undefined ? { worktreeRoot: durable.worktreeRoot } : {}),
      bgTaskId: durable.forkId,
    } satisfies RequestContext);

  const profile = profileFromDurableSpec(durable, resumeCtx);
  if (profile === null) {
    return {
      ok: false,
      code: "unknown_agent",
      reason: `Agent definition "${durable.agentId}" is unavailable, so agent ${to} cannot resume.`,
    };
  }
  profiles.set(profile.forkId, profile);
  if (!idByName.has(profile.name)) idByName.set(profile.name, profile.forkId);
  return { ok: true, profile };
}

function profileFromDurableSpec(
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
    definitionFields = {
      extraDeclarations: mcpDeclarationsForDef(def, allowSet),
      skillMessages: skillMessagesForDef(def),
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
    name: durable.name,
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
    agentName: durable.name,
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
    name: durable.name,
    spec,
    ctx,
    state: "finished",
    task,
    ...(durable.initialMessages !== undefined
      ? { baseMessages: snapshotMessages(durable.initialMessages) ?? [] }
      : {}),
  };
}

export function mergeResumedMessages(args: {
  baseMessages?: Message[];
  history: Message[];
  steers: Message[];
  prompt: string;
}): Message[] {
  const promptMessage: Message = {
    role: "user",
    content: [{ type: "text", text: args.prompt }],
  };
  if (args.baseMessages === undefined) {
    return sanitizeMessages([...args.history, ...args.steers, promptMessage]);
  }

  const durableIds = new Set(
    args.history.flatMap((message) => (message.id === undefined ? [] : [message.id])),
  );
  const baseMessages = (snapshotMessages(args.baseMessages) ?? []).filter(
    (message) => message.id === undefined || !durableIds.has(message.id),
  );
  const transcriptAfterInitialPrompt =
    args.history[0]?.role === "user" ? args.history.slice(1) : args.history;
  return sanitizeMessages([
    ...baseMessages,
    ...transcriptAfterInitialPrompt,
    ...args.steers,
    promptMessage,
  ]);
}

interface UndrainedSteer {
  message: Message;
  text: string;
  queueId?: string;
}

function drainUndrainedSteers(forkId: string): UndrainedSteer[] {
  const steers: UndrainedSteer[] = [];
  for (const queued of drainAgentSteers(forkId)) {
    steers.push({
      message: {
        role: "user",
        content: queued.blocks,
        ...(queued.queueId !== undefined ? { id: queued.queueId } : {}),
      },
      text: queued.text,
      ...(queued.queueId !== undefined ? { queueId: queued.queueId } : {}),
    });
  }
  return steers;
}

// Persist each undrained steer as a user record in the sidechain transcript, in
// queue order, immediately before the resume prompt record (which the fork loop
// writes when the resumed run starts). Without this, only the prompt is
// persisted, so a second resume rebuilds history missing these steers and the
// agent's replies reference a message that is no longer there.
async function persistResumeSteerRecords(
  profile: ForkResumeProfile,
  steers: UndrainedSteer[],
): Promise<void> {
  for (const steer of steers) {
    await appendAgentRecordRaw(
      {
        cwd: profile.ctx.originalCwd ?? profile.ctx.cwd,
        sessionId: profile.ctx.sessionId,
        agentId: profile.forkId,
      },
      {
        type: "user_message",
        ts: nowIso(),
        content: steer.text,
        provider: profile.ctx.provider,
        model: profile.ctx.model,
        isSidechain: true,
        ...(steer.queueId !== undefined ? { queueId: steer.queueId } : {}),
        ...(profile.spec.parentToolCallId !== undefined
          ? { parentToolCallId: profile.spec.parentToolCallId }
          : {}),
        ...(profile.spec.agentId !== undefined ? { agentId: profile.spec.agentId } : {}),
      },
    );
  }
}

function activeTaskForRun(run: TaskRunRef): BackgroundTask | undefined {
  const current = getBackgroundTask(run.taskId);
  if (
    current?.runGeneration !== run.generation ||
    current.runToken !== run.token ||
    current.status !== "running"
  ) {
    return undefined;
  }
  return current;
}

function routeResumedEvent(run: TaskRunRef, event: ForkEvent): void {
  if (activeTaskForRun(run) === undefined) return;
  const taskId = run.taskId;
  if (event.kind === "fork_tool_dispatch_start") {
    appendAction(taskId, {
      id: event.toolCallId,
      toolName: event.toolName,
      argsLabel: previewArgs(event.input),
      running: true,
      ts: Date.now(),
    });
  } else if (event.kind === "fork_tool_dispatch_complete") {
    event.isError ? failAction(taskId, event.toolCallId) : completeAction(taskId, event.toolCallId);
  } else if (event.kind === "fork_start") {
    setModel(taskId, event.model, event.effort, event.provider);
  } else if (event.kind === "fork_usage") {
    const usage = {
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheCreationInputTokens: event.cacheCreationInputTokens,
      cacheReadInputTokens: event.cacheReadInputTokens,
    };
    event.isSnapshot ? setUsageSnapshot(taskId, usage) : addUsage(taskId, usage);
  } else if (event.kind === "fork_text_delta") {
    appendAssistantText(taskId, event.text);
  } else if (event.kind === "fork_stream_reset") {
    discardAssistantText(taskId, event.discardedChars);
  }
}

export async function resumeForkWithMessage(
  to: string,
  prompt: string,
  requestCtx?: RequestContext,
): Promise<ForkMessageResult> {
  const resolved = await resolveForkProfileForResume(to, requestCtx);
  if (!resolved.ok) return { delivered: false, code: resolved.code, reason: resolved.reason };
  const { profile } = resolved;
  if (profile.state === "running" || profile.state === "resuming") {
    queueAgentSteer(profile.forkId, {
      text: prompt,
      blocks: [{ type: "text", text: prompt }],
    });
    return { delivered: true, agentId: profile.forkId, resumed: false };
  }

  const latestTask = getBackgroundTask(profile.forkId) ?? profile.task;
  if (latestTask?.stoppedByUser === true) {
    return {
      delivered: false,
      code: "stopped_by_user",
      reason: `Agent ${profile.forkId} was halted by the user, so it will not resume. Consider its work cancelled, and start a new agent only when the user explicitly requests one.`,
    };
  }
  if (!latestTask) {
    return {
      delivered: false,
      code: "not_resumable",
      reason: `Agent ${profile.forkId} has no background task to resume.`,
    };
  }
  if (latestTask.status === "running") {
    return {
      delivered: false,
      code: "already_running",
      reason: `Agent ${profile.forkId} is already running or being resumed.`,
    };
  }

  profile.state = "resuming";
  let history: Message[];
  try {
    const records = await loadSubagentTranscript({
      cwd: profile.ctx.originalCwd ?? profile.ctx.cwd,
      sessionId: profile.ctx.sessionId,
      forkId: profile.forkId,
    });
    history = sessionRecordsToMessages(records);
  } catch (error) {
    profile.state = "finished";
    return {
      delivered: false,
      code: "not_resumable",
      reason: `Failed to read transcript for agent ${profile.forkId}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (history.length === 0) {
    profile.state = "finished";
    return {
      delivered: false,
      code: "not_resumable",
      reason: `No saved transcript exists for agent ID ${profile.forkId}, so it cannot be resumed.`,
    };
  }

  const reopened = getBackgroundTask(profile.forkId)
    ? reopenTask(profile.forkId)
    : restoreTaskForResume(latestTask);
  if (!reopened) {
    profile.state = "finished";
    return {
      delivered: false,
      code: "already_running",
      reason: `Agent ${profile.forkId} is already running or being resumed.`,
    };
  }
  const resumedRun = taskRunRef(reopened);
  markBackgrounded(reopened.id);
  // A resumed child keeps notifying its parent while that owner is still a
  // live registered scope; ownership resets to the main session only when the
  // prior owner is gone (its undelivered inventory was already redirected).
  const priorOwner = reopened.ownerId;
  if (priorOwner === undefined || !emitQueue.isOwnerRegistered(priorOwner)) {
    setTaskOwnerForRun(resumedRun, undefined);
  }
  profile.task = getBackgroundTask(reopened.id) ?? reopened;

  const undrainedSteers = drainUndrainedSteers(profile.forkId);
  const messages = mergeResumedMessages({
    ...(profile.baseMessages !== undefined ? { baseMessages: profile.baseMessages } : {}),
    history,
    steers: undrainedSteers.map((steer) => steer.message),
    prompt,
  });
  // Record the steers before starting the run so they land ahead of the prompt
  // record the fork loop writes; the queue was just drained, so the resumed
  // loop's own drainer will not re-inject them and the next resume gets them
  // only through the rebuilt transcript.
  await persistResumeSteerRecords(profile, undrainedSteers);
  const abortController = new AbortController();
  const eventSink = (event: ForkEvent): void => routeResumedEvent(resumedRun, event);
  const { isolation: previousIsolation, ...nonIsolatedSpec } = profile.spec;
  const resumeSpec: ForkSpec = {
    ...(previousIsolation === "worktree" ? nonIsolatedSpec : profile.spec),
    preserveDurableSpec: true,
  };
  const worktreeMissing =
    previousIsolation === "worktree" &&
    profile.ctx.worktreeRoot !== undefined &&
    !existsSync(profile.ctx.worktreeRoot);
  const { worktreeRoot: _previousWorktreeRoot, ...ctxWithoutWorktree } = profile.ctx;
  const resumeCtx: RequestContext = {
    ...(worktreeMissing ? ctxWithoutWorktree : profile.ctx),
    ...(worktreeMissing && profile.ctx.originalCwd !== undefined
      ? { cwd: profile.ctx.originalCwd }
      : {}),
    abortSignal: abortController.signal,
    eventSink,
  };
  // The resumed run reuses the existing isolation worktree (isolation was
  // stripped from resumeSpec, so the fork loop neither creates nor leases it).
  // Nothing else bumps its mtime or holds a lease, so hold one here for the
  // run's lifetime to keep the orphan prune from deleting it under a live agent.
  const reusedWorktreeRoot =
    previousIsolation === "worktree" && !worktreeMissing ? profile.ctx.worktreeRoot : undefined;
  const resumeWorktreeLease =
    reusedWorktreeRoot !== undefined ? await acquireResumedWorktreeLease(reusedWorktreeRoot) : null;
  if (activeTaskForRun(resumedRun) === undefined) {
    if (resumeWorktreeLease) await resumeWorktreeLease.release();
    const stoppedTask = getBackgroundTask(resumedRun.taskId);
    profile.state = "finished";
    if (stoppedTask !== undefined) profile.task = stoppedTask;
    if (stoppedTask?.stoppedByUser === true) {
      return {
        delivered: false,
        code: "stopped_by_user",
        reason: `Agent ${profile.forkId} was halted by the user, so it will not resume. Consider its work cancelled, and start a new agent only when the user explicitly requests one.`,
      };
    }
    return {
      delivered: false,
      code: "not_resumable",
      reason: `Agent ${profile.forkId} stopped before its resumed run could start.`,
    };
  }
  const resumeController = {
    signal: () => {},
    isBackgrounded: () => true,
    abort: () => abortController.abort("user-cancel"),
    taskId: reopened.id,
  };
  const releaseController = bgControllers.register(reopened.parentToolCallId, resumeController);

  void (async () => {
    try {
      const result = await runForkLoopExternal({
        ...resumeSpec,
        ctx: resumeCtx,
        sink: eventSink,
        forkId: profile.forkId,
        prompt,
        initialMessages: messages,
        promptInlineImages: undefined,
      });
      completeTaskForRun(resumedRun, {
        content: result.output,
        isError: result.isError,
      });
    } catch (error) {
      if (isAbortError(error) || abortController.signal.aborted) {
        cancelTaskTree(resumedRun, {
          reason: error instanceof Error ? error.message : "aborted",
          suppressRootNotification: false,
        });
      } else {
        completeTaskForRun(resumedRun, {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        });
      }
    } finally {
      if (resumeWorktreeLease) await resumeWorktreeLease.release();
      releaseController();
      // A run that started registers its own profile (whose disposer deletes
      // it); if the map still holds the pre-run profile object, the run never
      // reached registration and the entry would linger with its messages.
      if (profiles.get(profile.forkId) === profile && profile.state !== "running") {
        profiles.delete(profile.forkId);
      }
    }
  })();

  return { delivered: true, agentId: profile.forkId, resumed: true };
}

subscribeCompletion((task) => {
  const stoppedForkId =
    task.stoppedByUser === true && task.kind === "agent" ? (task.forkId ?? task.id) : undefined;
  if (stoppedForkId !== undefined && task.cwd !== undefined && task.sessionId !== undefined) {
    try {
      markDurableForkStopped({
        cwd: task.cwd,
        sessionId: task.sessionId,
        forkId: stoppedForkId,
      });
    } catch (error) {
      publish(
        "error",
        `Failed to persist stop marker for agent ${stoppedForkId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const profile = profiles.get(task.id);
  if (!profile) return;
  profile.task = task;
  if (task.status !== "running") profile.state = "finished";
});

export function clearForkLifecyclesForTests(): void {
  profiles.clear();
  idByName.clear();
}
