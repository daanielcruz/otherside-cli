import { existsSync } from "node:fs";
import { addressedMessageText, registerAgent } from "@/engine/agents/inbox.ts";
import {
  cancelTaskTree,
  completeTaskForRun,
  get as getBackgroundTask,
  markBackgrounded,
  reopenTask,
  restoreTaskForResume,
  setTaskOwnerForRun,
  subscribeCompletion,
  taskRunRef,
} from "@/engine/background/tasks/background.ts";
import * as bgControllers from "@/engine/background/tasks/background-controllers.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import { loadSubagentTranscript } from "@/engine/session/transcript/subagent-transcript.ts";
import { sessionRecordsToMessages } from "@/engine/session/transcript/to-messages.ts";
import { clearReadStateForScope } from "@/engine/tools/builtins/read/state.ts";
import { clearSessionHooks } from "@/kernel/hooks/session-registry.ts";
import { isAbortError } from "@/kernel/std/stream/abort.ts";
import type { ForkEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { type ForkResumeProfile, profileFromDurableSpec } from "./durable-profile.ts";
import {
  isDurableForkStopped,
  markDurableForkStopped,
  readDurableForkSpec,
} from "./fork/durable-spec.ts";
import { runForkLoopExternal } from "./fork/loop.ts";
import {
  askForkRouteApproval,
  classifyForkRouteSwitch,
  type RequestedForkRoute,
  withPinnedForkRoute,
} from "./fork/route-override.ts";
import { queueAgentSteer } from "./fork/steering.ts";
import type { ForkSpec } from "./fork/types.ts";
import { activeTaskForRun, routeResumedEvent } from "./resume-events.ts";
import {
  drainUndrainedSteers,
  mergeResumedMessages,
  persistResumeSteerRecords,
  queuedSteerIds,
  snapshotMessages,
} from "./resume-messages.ts";
import { acquireResumedWorktreeLease } from "./worktree.ts";

export type ForkMessageFailure =
  | "unknown_agent"
  | "not_resumable"
  | "stopped_by_user"
  | "already_running"
  | "route_rejected"
  | "route_denied";

export type ForkMessageResult =
  // `warning` rides a delivered message so a no-op routing field reaches both
  // the caller's tool result and the transcript surface that renders it.
  | { delivered: true; agentId: string; resumed: boolean; warning?: string }
  | { delivered: false; code: ForkMessageFailure; reason: string };

type ForkProfileResolution =
  | { ok: true; profile: ForkResumeProfile }
  | { ok: false; code: "unknown_agent" | "stopped_by_user"; reason: string };

const profiles = new Map<string, ForkResumeProfile>();

// A resume waits here until the run it scheduled actually registers. The fork loop
// yields several times before that point (module load, worktree, MCP), so reporting
// the delivery when the call returns would claim a message that a cancel or an exit
// inside that window erases.
const registrationWaiters = new Map<string, Set<() => void>>();

function announceForkRegistration(forkId: string): void {
  const waiters = registrationWaiters.get(forkId);
  if (waiters === undefined) return;
  registrationWaiters.delete(forkId);
  for (const wake of waiters) wake();
}

function awaitForkRegistration(forkId: string): {
  registered: Promise<void>;
  stopWaiting: () => void;
} {
  let wake: () => void = () => {};
  const registered = new Promise<void>((resolve) => {
    wake = () => resolve();
  });
  const waiters = registrationWaiters.get(forkId) ?? new Set<() => void>();
  waiters.add(wake);
  registrationWaiters.set(forkId, waiters);
  return {
    registered,
    stopWaiting: () => {
      const current = registrationWaiters.get(forkId);
      if (current === undefined) return;
      current.delete(wake);
      if (current.size === 0) registrationWaiters.delete(forkId);
    },
  };
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
  announceForkRegistration(forkId);
  const releaseInbox = registerAgent(forkId, (message) => {
    // A fork whose stop already fired (user cancel) must not swallow the message
    // on the fast path: reject it so the inbox reports the delivery failed and
    // SendMessage falls through to the resume path, which returns the truthful
    // stopped_by_user outcome instead of silently dropping the steer.
    if (ctx.abortSignal?.aborted === true || getBackgroundTask(forkId)?.stoppedByUser === true) {
      throw new Error(`agent ${forkId} is stopping and cannot accept messages`);
    }
    const text = addressedMessageText(message);
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
  return {
    ok: false,
    code: "unknown_agent",
    reason: `No agent found for id "${to}".`,
  };
}

export async function resolveForkProfileForResume(
  to: string,
  requestCtx: RequestContext | undefined,
): Promise<ForkProfileResolution> {
  const resolved = resolveProfile(to);
  if (resolved.ok) return resolved;
  const forkId = to;
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
  return { ok: true, profile };
}

type ResumeRouteOutcome =
  | { ok: true; warning?: string }
  | { ok: false; failure: Extract<ForkMessageResult, { delivered: false }> };

// The resume route is settled before the transcript is touched: a rejected or
// denied switch must leave the agent exactly as it was, message included.
async function resolveResumeRoute(
  profile: ForkResumeProfile,
  route: RequestedForkRoute | undefined,
  requestCtx: RequestContext | undefined,
  isLive: boolean,
): Promise<ResumeRouteOutcome> {
  if (route === undefined) return { ok: true };
  const current = { provider: profile.ctx.provider, model: profile.ctx.model };
  const gateCtx = requestCtx ?? profile.ctx;
  const classified = classifyForkRouteSwitch(route, current, gateCtx, profile.forkId);
  if (classified.kind === "inherit") return { ok: true };
  if (classified.kind === "noop") return { ok: true, warning: classified.warning };
  if (classified.kind === "rejected") {
    return {
      ok: false,
      failure: { delivered: false, code: "route_rejected", reason: classified.error },
    };
  }
  if (isLive) {
    return {
      ok: false,
      failure: {
        delivered: false,
        code: "already_running",
        reason: `Agent ${profile.forkId} is still running, and a routing switch only takes effect on a resumed run. Send the switch once its current run has finished.`,
      },
    };
  }
  const approval = await askForkRouteApproval({
    requested: classified.route,
    session: current,
    subject: profile.forkId,
    ...(gateCtx.abortSignal !== undefined ? { signal: gateCtx.abortSignal } : {}),
  });
  if (!approval.ok) {
    return {
      ok: false,
      failure: { delivered: false, code: "route_denied", reason: approval.error },
    };
  }
  profile.ctx = withPinnedForkRoute(profile.ctx, classified.route);
  return { ok: true };
}

export async function resumeForkWithMessage(
  to: string,
  prompt: string,
  requestCtx?: RequestContext,
  route?: RequestedForkRoute,
): Promise<ForkMessageResult> {
  const resolved = await resolveForkProfileForResume(to, requestCtx);
  if (!resolved.ok) return { delivered: false, code: resolved.code, reason: resolved.reason };
  const { profile } = resolved;
  const isLive = profile.state === "running" || profile.state === "resuming";
  const switched = await resolveResumeRoute(profile, route, requestCtx, isLive);
  if (!switched.ok) return switched.failure;
  const warning = switched.warning;
  if (isLive) {
    queueAgentSteer(profile.forkId, {
      text: prompt,
      blocks: [{ type: "text", text: prompt }],
    });
    return {
      delivered: true,
      agentId: profile.forkId,
      resumed: false,
      ...(warning !== undefined ? { warning } : {}),
    };
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
  // Everything queued at this instant predates the prompt being accepted, so it
  // belongs ahead of it. Anything arriving from here on belongs after the prompt
  // and is left for the resumed loop's drainer, which records it in that order.
  const steerIdsBeforePrompt = queuedSteerIds(profile.forkId);
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

  const undrainedSteers = drainUndrainedSteers(profile.forkId, steerIdsBeforePrompt);
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
  try {
    await persistResumeSteerRecords(profile, undrainedSteers);
  } catch (error) {
    // The task is already reopened and the steers already off the queue. Put them
    // back and end the run, or the agent stays running forever on messages that
    // reached no transcript.
    for (const steer of undrainedSteers) {
      queueAgentSteer(profile.forkId, {
        text: steer.text,
        blocks: [{ type: "text", text: steer.text }],
        ...(steer.queueId !== undefined ? { queueId: steer.queueId } : {}),
      });
    }
    const reason = error instanceof Error ? error.message : String(error);
    completeTaskForRun(resumedRun, { content: reason, isError: true });
    profile.state = "finished";
    return {
      delivered: false,
      code: "not_resumable",
      reason: `Agent ${profile.forkId} could not record its pending messages: ${reason}`,
    };
  }
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

  const { registered, stopWaiting } = awaitForkRegistration(profile.forkId);
  const run = (async () => {
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

  // The run settles without ever registering when it is cancelled or fails during
  // that window; the message reached no transcript, so it was never delivered.
  const outcome = await Promise.race([
    registered.then(() => "registered" as const),
    run.then(() => "ended" as const),
  ]);
  stopWaiting();
  if (outcome === "ended") {
    profile.state = "finished";
    return {
      delivered: false,
      code: "not_resumable",
      reason: `Agent ${profile.forkId} stopped before its resumed run could start.`,
    };
  }
  return {
    delivered: true,
    agentId: profile.forkId,
    resumed: true,
    ...(warning !== undefined ? { warning } : {}),
  };
}

subscribeCompletion((task) => {
  const stoppedForkId =
    task.stoppedByUser === true && task.kind === "agent" ? (task.forkId ?? task.id) : undefined;
  if (stoppedForkId !== undefined && task.cwd !== undefined && task.sessionId !== undefined) {
    // Best-effort cross-process marker: within this process the live task's
    // stoppedByUser flag already refuses the resume, so a write failure has no
    // caller to answer and nothing for the user to act on.
    try {
      markDurableForkStopped({
        cwd: task.cwd,
        sessionId: task.sessionId,
        forkId: stoppedForkId,
      });
    } catch {}
  }
  const profile = profiles.get(task.id);
  if (!profile) return;
  profile.task = task;
  if (task.status !== "running") profile.state = "finished";
});

export function clearForkLifecyclesForTests(): void {
  profiles.clear();
}
