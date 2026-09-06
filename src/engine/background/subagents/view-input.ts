import { existsSync } from "node:fs";
import { get as getAgentDef } from "@/engine/agents/registry.ts";
import { readDurableForkSpec } from "@/engine/background/subagents/fork/durable-spec.ts";
import { acquireResumedWorktreeLease } from "@/engine/background/subagents/worktree.ts";
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
  reopenTask,
  setRoute,
  setUsageSnapshot,
  type TaskRunRef,
  taskRunRef,
} from "@/engine/background/tasks/background.ts";
import * as bgControllers from "@/engine/background/tasks/background-controllers.ts";
import { findModel } from "@/engine/model/catalog.ts";
import type { Agent } from "@/engine/queue/index.ts";
import { previewArgs } from "@/engine/queue/runtime/args-preview.ts";
import { makeRequestContext } from "@/engine/queue/runtime/request-context.ts";
import { appendAgentRecordRaw } from "@/engine/session/append.ts";
import { loadSubagentTranscript } from "@/engine/session/transcript/subagent-transcript.ts";
import { sessionRecordsToMessages } from "@/engine/session/transcript/to-messages.ts";
import { sanitizeMessages } from "@/engine/translator/sanitize.ts";
import { isAbortError } from "@/kernel/std/stream/abort.ts";
import type { ForkEvent } from "@/kernel/std/types/events.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { mcpDeclarationsForDef } from "./fork/declarations.ts";
import { runForkLoopExternal } from "./fork/loop.ts";
import { computeAllowedAgentTypes, resolveAllowSetForFork } from "./fork/profile.ts";
import { injectQueuedUserInput } from "./fork/queued-input.ts";
import { skillMessagesForDef } from "./fork/skill-messages.ts";
import { drainAgentSteers, queueAgentSteer } from "./fork/steering.ts";
import type { ForkSpec, SidechainRecord } from "./fork/types.ts";

export interface ViewedAgentInput {
  task: BackgroundTask;
  sessionId: string;
  cwd: string;
  text: string;
  blocks: ContentBlock[];
}

// Persist only when drained so cancelled input never appears delivered.
export async function steerViewedAgent(input: ViewedAgentInput): Promise<boolean> {
  if (input.task.forkId === undefined) return false;
  queueAgentSteer(input.task.forkId, {
    text: input.text,
    blocks: input.blocks,
  });
  return true;
}

function routeResumedAgentEvent(
  run: TaskRunRef,
  event: ForkEvent,
  sink: (event: ForkEvent) => void,
): void {
  const current = getBackgroundTask(run.taskId);
  if (
    current?.runGeneration !== run.generation ||
    current.runToken !== run.token ||
    current.status !== "running"
  ) {
    return;
  }
  const taskId = run.taskId;
  sink(event);
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
    setRoute(taskId, { provider: event.provider, model: event.model }, event.effort);
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

// Text submitted from the agent view after the agent finished: rebuild the
// agent's conversation from its sidechain transcript, append the new user
// prompt, and run the fork again under the SAME forkId (so the run appends to
// the same transcript and the same panel row). Completion flows through
// completeTask like any background agent, notifying the main loop.
export async function resumeViewedAgent(
  input: ViewedAgentInput & { agent: Agent; eventSink: (event: ForkEvent) => void },
): Promise<boolean> {
  const { task } = input;
  const forkId = task.forkId;
  if (forkId === undefined || task.status === "running") return false;
  const transcriptSessionId = task.sessionId ?? input.sessionId;
  const taskCwd = task.cwd ?? input.cwd;
  const records = await loadSubagentTranscript({
    cwd: taskCwd,
    sessionId: transcriptSessionId,
    forkId,
  });
  const rebuilt = sanitizeMessages(sessionRecordsToMessages(records));
  if (rebuilt.length === 0) return false;

  // An agent isolated in a worktree recorded where it lives; resuming it anywhere
  // else would let it write into the project root it was isolated from.
  const durable = await readDurableForkSpec({
    cwd: taskCwd,
    sessionId: transcriptSessionId,
    forkId,
  });
  const worktreeRoot =
    durable?.worktreeRoot !== undefined && existsSync(durable.worktreeRoot)
      ? durable.worktreeRoot
      : undefined;
  const runCwd = worktreeRoot ?? taskCwd;

  const baseCtx = makeRequestContext(input.agent.deps);
  const taskRoute =
    task.route ??
    (task.provider !== undefined && task.model !== undefined
      ? { provider: task.provider, model: task.model }
      : null);
  const modelEntry = taskRoute === null ? undefined : findModel(taskRoute);
  const def = getAgentDef(task.agentId ?? task.agentName);
  if (def === undefined) return false;
  const abort = new AbortController();
  let resumedRun: TaskRunRef | undefined;
  const eventSink = (event: ForkEvent): void => {
    if (resumedRun !== undefined) routeResumedAgentEvent(resumedRun, event, input.eventSink);
  };
  const ctx: RequestContext = {
    ...baseCtx,
    provider: taskRoute?.provider ?? baseCtx.provider,
    model: modelEntry?.id ?? taskRoute?.model ?? baseCtx.model,
    effort: task.effort ?? baseCtx.effort,
    sessionId: transcriptSessionId,
    cwd: runCwd,
    ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
    ...(durable?.originalCwd !== undefined ? { originalCwd: durable.originalCwd } : {}),
    eventSink,
    abortSignal: abort.signal,
    ...(task.ownerId !== undefined ? { agentOwnerId: task.ownerId } : {}),
  };
  const allowSet = resolveAllowSetForFork(def, "subagent", ctx);
  const skills = skillMessagesForDef(def);
  const resumeSpec: ForkSpec = {
    ctx,
    name: task.agentName,
    body: def.body.trim().length > 0 ? def.body : `You are the ${def.name} subagent.`,
    allowSet,
    prompt: input.text,
    ...(task.description !== undefined ? { description: task.description } : {}),
    sink: eventSink,
    parentToolCallId: task.parentToolCallId,
    agentId: def.id,
    forkId,
    preserveDurableSpec: true,
    promptInlineImages: input.blocks.filter((block) => block.type === "image"),
    extraDeclarations: mcpDeclarationsForDef(def, allowSet),
    skillMessages: skills.messages,
    ...(skills.warnings.length > 0 ? { setupWarnings: skills.warnings } : {}),
    agentHooks: def.hooks ?? null,
    allowedAgentTypes: computeAllowedAgentTypes(def),
    allowNestedAgents: true,
    inlineMcpServers: def.mcpServers,
    ...(def.maxTurns !== undefined ? { maxTurns: def.maxTurns } : {}),
    ...(def.permissionMode !== undefined ? { permissionMode: def.permissionMode } : {}),
  };
  const reopened = reopenTask(task.id);
  if (reopened === undefined) {
    const current = getBackgroundTask(task.id);
    if (current?.status !== "running") return false;
    return await steerViewedAgent({
      ...input,
      task: current,
    });
  }
  const run = taskRunRef(reopened);
  resumedRun = run;

  const messages = [...rebuilt];
  const queuedSteers = drainAgentSteers(forkId);
  if (queuedSteers.length > 0) {
    const queuedRecords: SidechainRecord[] = [];
    injectQueuedUserInput({
      spec: { ...resumeSpec, pendingUserInputDrainer: () => queuedSteers },
      fork: messages,
      ctx,
      appendSidechainRecord: (record) => queuedRecords.push(record),
    });
    try {
      for (const record of queuedRecords) {
        await appendAgentRecordRaw(
          { cwd: taskCwd, sessionId: transcriptSessionId, agentId: forkId },
          {
            ...record,
            isSidechain: true,
            parentToolCallId: task.parentToolCallId,
            agentId: def.id,
          },
        );
      }
    } catch (error) {
      for (const steer of queuedSteers) queueAgentSteer(forkId, steer);
      completeTaskForRun(run, {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      });
      return false;
    }
  }
  messages.push({ role: "user" as const, content: input.blocks });

  const resumeController = {
    signal: () => {},
    isBackgrounded: () => true,
    abort: () => abort.abort(),
    taskId: task.id,
  };
  const releaseController = bgControllers.register(task.parentToolCallId, resumeController);
  // Nothing else bumps the worktree's mtime while this run holds it, so the orphan
  // prune would delete it under a live agent without a lease.
  const worktreeLease =
    worktreeRoot !== undefined ? await acquireResumedWorktreeLease(worktreeRoot) : null;
  void (async () => {
    try {
      const result = await runForkLoopExternal({ ...resumeSpec, initialMessages: messages });
      completeTaskForRun(run, { content: result.output, isError: result.isError === true });
    } catch (err) {
      if (isAbortError(err) || abort.signal.aborted) {
        cancelTaskTree(run, {
          reason: err instanceof Error ? err.message : "aborted",
        });
      } else {
        completeTaskForRun(run, {
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        });
      }
    } finally {
      if (worktreeLease) await worktreeLease.release();
      releaseController();
    }
  })();
  return true;
}
