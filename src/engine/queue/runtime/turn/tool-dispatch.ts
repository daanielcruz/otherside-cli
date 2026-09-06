import { runWithPermissionResolver } from "@/engine/agents/agent-context.ts";
import { get as getAgentDef } from "@/engine/agents/registry.ts";
import {
  addUsage as bgAddUsage,
  appendAction as bgAppendAction,
  appendAssistantText as bgAppendAssistantText,
  completeAction as bgCompleteAction,
  detachTaskForRun as bgDetachTaskForRun,
  discardAssistantText as bgDiscardAssistantText,
  failAction as bgFailAction,
  setForkId as bgSetForkId,
  setModel as bgSetModel,
  setUsageSnapshot as bgSetUsageSnapshot,
  startTask as bgStartTask,
  type TaskRunRef,
  taskRunRef,
} from "@/engine/background/tasks/background.ts";
import * as bgControllers from "@/engine/background/tasks/background-controllers.ts";
import { wrapNotificationForModel } from "@/engine/background/tasks/notification.ts";
import { listEnabledHookHandlers } from "@/engine/plugins/registry.ts";
import { QuotaExhaustedError } from "@/engine/providers/_shared/retry.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import { previewArgs } from "@/engine/queue/runtime/args-preview.ts";
import { partitionForConcurrency } from "@/engine/queue/runtime/concurrency.ts";
import { mergeAsyncStreams } from "@/engine/queue/runtime/merge-async-streams.ts";
import { collectNestedMemoryForTool } from "@/engine/queue/runtime/nested-memory.ts";
import { drainOrphanInterrupts } from "@/engine/queue/runtime/orphan-synth.ts";
import { resolvePermission } from "@/engine/queue/runtime/permission-resolution.ts";
import { queuedInputBlocks } from "@/engine/queue/runtime/turn-prompts.ts";
import { appendRecord, nowIso } from "@/engine/session/index.ts";
import {
  foldTextIntoToolResult,
  lastFoldableToolResult,
} from "@/engine/session/transcript/tool-result-fold.ts";
import { resolveToolResultImagesForNonVision } from "@/engine/tools/builtins/image/parse-image.ts";
import { dispatch as dispatchTool } from "@/engine/tools/pipeline.ts";
import { maxConcurrentToolUses } from "@/kernel/config/tool-use-concurrency.ts";
import { firePostToolBatchHooks, handlersFromConfig } from "@/kernel/hooks/handler.ts";
import { AsyncStream } from "@/kernel/std/stream/async.ts";
import type { AgentEvent, BackgroundController } from "@/kernel/std/types/events.ts";
import { type ContentBlock, type ToolCall } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  commitDispatchToolResult,
  type DispatchEntry,
  settleDispatch,
  stageDispatchTaskCompletion,
  TurnCancelledError,
} from "./dispatch-settle.ts";
import type { TurnLoopHost } from "./types.ts";

const BASH_PROMOTION_HANDOFF_GRACE_MS = 250;

export function appendNotificationRecords(
  host: TurnLoopHost,
  notifications: readonly string[],
): void {
  for (const text of notifications) {
    appendRecord(host.deps.session, {
      type: "attachment",
      ts: nowIso(),
      attachment: {
        type: "queued_command",
        prompt: text,
        commandMode: "task-notification",
        isMeta: true,
      },
    }).catch(() => {});
  }
}

export function createConcurrencyWindow(
  limit: number,
): <T>(task: () => Promise<T>, releaseSignal?: Promise<unknown>) => Promise<T> {
  const pending: Array<() => void> = [];
  const maxActive = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  let active = 0;

  return <T>(task: () => Promise<T>, releaseSignal?: Promise<unknown>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        active += 1;
        const result = Promise.resolve().then(task);
        const release = releaseSignal ? Promise.race([result, releaseSignal]) : result;
        release
          .catch(() => {})
          .finally(() => {
            active -= 1;
            pending.shift()?.();
          });
        result.then(resolve, reject);
      };

      if (active < maxActive) start();
      else pending.push(start);
    });
}

export async function* dispatchTurnToolCalls(args: {
  host: TurnLoopHost;
  controller: AbortController;
  toolCalls: ToolCall[];
  ctx: RequestContext;
}): AsyncGenerator<AgentEvent, "continue" | "stop"> {
  const { host, controller, toolCalls, ctx } = args;
  const resultBlocks: ContentBlock[] = [];
  const taskBoundaryEntries: DispatchEntry[] = [];
  try {
    for (const group of partitionForConcurrency(toolCalls)) {
      const dispatchEntries: DispatchEntry[] = [];
      const runInWindow = createConcurrencyWindow(maxConcurrentToolUses());
      for (const call of group) {
        if (host.cancelled) {
          resultBlocks.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: "Interrupted by user",
            is_error: true,
          });
          continue;
        }
        const queue = new AsyncStream<AgentEvent>();
        const flags = { backgrounded: false, dispatchDone: false, settled: false };
        let backgroundResolve: (() => void) | null = null;
        const backgroundPromise = new Promise<void>((resolve) => {
          backgroundResolve = resolve;
        });
        const abortController = new AbortController();
        let bgTaskId: string | undefined;
        let bgRun: TaskRunRef | undefined;
        const toolController: BackgroundController = {
          signal: () => {
            if (flags.backgrounded) return;
            flags.backgrounded = true;
            if (bgRun !== undefined) bgDetachTaskForRun(bgRun);
            host.activeToolAbortControllers.delete(abortController);
            backgroundResolve?.();
            queue.signal();
          },
          isBackgrounded: () => flags.backgrounded,
          abort: () => {
            abortController.abort();
            backgroundResolve?.();
            queue.signal();
          },
          signaled: backgroundPromise,
        };
        const isAgentTool = call.name === "Agent";
        const isBashTool = call.name === "Bash";
        const isBackgroundable = isAgentTool || isBashTool;
        host.activeToolAbortControllers.add(abortController);

        if (isAgentTool) {
          const inputObj = (call.input ?? {}) as {
            subagent_type?: unknown;
            description?: unknown;
            prompt?: unknown;
          };
          const slug =
            typeof inputObj.subagent_type === "string" ? inputObj.subagent_type : "general-purpose";
          const agentName = getAgentDef(slug)?.name ?? slug;
          const description =
            typeof inputObj.description === "string" ? inputObj.description : undefined;
          const prompt = typeof inputObj.prompt === "string" ? inputObj.prompt : undefined;
          const task = bgStartTask({
            parentToolCallId: call.id,
            lifecycleMode: "linked",
            agentName,
            agentId: slug,
            provider: ctx.provider,
            cwd: ctx.cwd,
            sessionId: ctx.sessionId,
            ...(description !== undefined ? { description } : {}),
            ...(prompt !== undefined ? { prompt } : {}),
          });
          bgTaskId = task.id;
          bgRun = taskRunRef(task);
          toolController.taskId = task.id;
        }
        const releaseController = isBackgroundable
          ? bgControllers.register(call.id, toolController)
          : () => {};

        const childTaskIdMap = new Map<string, string>();

        const ctxWithSink: RequestContext = {
          ...ctx,
          abortSignal: abortController.signal,
          parentMessages: host.deps.session.messages,
          progressSink: (progress) => {
            queue.push({ kind: "tool_dispatch_progress", id: call.id, name: call.name, progress });
          },
          eventSink: (event) => {
            const tagged = { ...event, parentToolCallId: event.parentToolCallId ?? call.id };
            queue.push(tagged);
            const resolvedTaskId =
              (event.parentToolCallId && childTaskIdMap.get(event.parentToolCallId)) || bgTaskId;
            if (resolvedTaskId) {
              if (event.kind === "fork_tool_dispatch_start") {
                bgAppendAction(resolvedTaskId, {
                  id: event.toolCallId,
                  toolName: event.toolName,
                  argsLabel: previewArgs(event.input),
                  running: true,
                  ts: Date.now(),
                });
              } else if (event.kind === "fork_tool_dispatch_complete") {
                event.isError
                  ? bgFailAction(resolvedTaskId, event.toolCallId)
                  : bgCompleteAction(resolvedTaskId, event.toolCallId);
              } else if (event.kind === "fork_start") {
                bgSetForkId(resolvedTaskId, event.forkId);
                bgSetModel(resolvedTaskId, event.model, event.effort, event.provider);
              } else if (event.kind === "fork_usage") {
                if (event.isSnapshot) {
                  bgSetUsageSnapshot(resolvedTaskId, {
                    inputTokens: event.inputTokens,
                    outputTokens: event.outputTokens,
                    cacheCreationInputTokens: event.cacheCreationInputTokens,
                    cacheReadInputTokens: event.cacheReadInputTokens,
                  });
                } else {
                  bgAddUsage(resolvedTaskId, {
                    inputTokens: event.inputTokens,
                    outputTokens: event.outputTokens,
                    cacheCreationInputTokens: event.cacheCreationInputTokens,
                    cacheReadInputTokens: event.cacheReadInputTokens,
                  });
                }
              } else if (event.kind === "fork_text_delta") {
                bgAppendAssistantText(resolvedTaskId, event.text);
              } else if (event.kind === "fork_stream_reset") {
                bgDiscardAssistantText(resolvedTaskId, event.discardedChars);
              }
            }
          },
          backgroundController: toolController,
          bgTaskId,
          childTaskIdMap,
        };
        const turnPermissionResolver = (toolCall: ToolCall) =>
          resolvePermission(
            {
              agentDeps: host.deps,
              injections: host.injections,
              sessionAllowedToolPatterns: host.sessionAllowedToolPatterns,
            },
            toolCall,
          );
        const dispatchPromise = runInWindow(
          () => {
            queue.push({
              kind: "tool_dispatch_start",
              id: call.id,
              name: call.name,
              input: call.input,
            });
            return runWithPermissionResolver(turnPermissionResolver, () =>
              dispatchTool(call, ctxWithSink, {
                permission: turnPermissionResolver,
                hooks: [...handlersFromConfig(host.deps.config), ...listEnabledHookHandlers()],
              }),
            );
          },
          isBackgroundable ? backgroundPromise : undefined,
        ).finally(() => {
          host.activeToolAbortControllers.delete(abortController);
          flags.dispatchDone = true;
          queue.signal();
          backgroundResolve?.();
        });
        dispatchPromise.catch(() => {});

        const entry: DispatchEntry = {
          call,
          queue,
          abortController,
          isAgentTool,
          isBackgroundable,
          bgTaskId,
          ...(bgRun !== undefined ? { bgRun } : {}),
          releaseController,
          toolResultCommitted: false,
          flags,
          backgroundPromise,
          dispatchPromise,
          outcome: Promise.resolve({ kind: "failed", error: null }),
        };
        entry.outcome = settleDispatch(host, entry);
        dispatchEntries.push(entry);
        taskBoundaryEntries.push(entry);
      }

      const { merged, done, isDrained } = mergeAsyncStreams({
        sources: dispatchEntries.map((entry) => ({
          queue: entry.queue,
          isDone: () => entry.flags.settled,
        })),
      });
      for await (const ev of merged.iterate(isDrained)) yield ev;
      await done;

      for (const entry of dispatchEntries) {
        const { call, isBackgroundable } = entry;
        const outcome = await entry.outcome;
        if (outcome.kind === "backgrounded") {
          resultBlocks.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: outcome.placeholder,
          });
          continue;
        }
        if (outcome.kind === "failed") {
          const status = yield* handleFailedDispatch({ host, entry, outcome, resultBlocks });
          if (isBackgroundable) entry.releaseController?.();
          if (status === "stop") return "stop";
          continue;
        }
        resultBlocks.push(outcome.block);
        collectNestedMemoryForTool(
          host.deps,
          {
            loadedPaths: host.loadedNestedMemoryPaths,
            byPath: host.nestedMemoryByPath,
          },
          call,
        );
      }
    }
  } finally {
    try {
      yield* finalizeToolDispatchBatch({ host, controller, toolCalls, ctx, resultBlocks });
    } finally {
      for (const entry of taskBoundaryEntries) commitDispatchToolResult(entry);
    }
  }
  return "continue";
}

function* handleFailedDispatch(args: {
  host: TurnLoopHost;
  entry: DispatchEntry;
  outcome: Extract<Awaited<DispatchEntry["outcome"]>, { kind: "failed" }>;
  resultBlocks: ContentBlock[];
}): Generator<AgentEvent, "continue" | "stop"> {
  const { host, entry, outcome, resultBlocks } = args;
  const err = outcome.error;
  const interrupted = host.cancelled || err instanceof TurnCancelledError;
  if (entry.bgTaskId) {
    stageDispatchTaskCompletion(entry, {
      content: interrupted
        ? "Interrupted by user"
        : `error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
      ...(interrupted ? { killed: true, userInitiated: true } : {}),
    });
  }
  if (interrupted) {
    resultBlocks.push({
      type: "tool_result",
      tool_use_id: entry.call.id,
      content: "Interrupted by user",
      is_error: true,
    });
    appendRecord(host.deps.session, {
      type: "tool_result",
      ts: nowIso(),
      call_id: entry.call.id,
      result: "Interrupted by user",
      is_error: true,
    }).catch(() => {});
    return "continue";
  }
  if (err instanceof QuotaExhaustedError) {
    yield {
      kind: "quota_exhausted",
      provider: err.provider,
      model: err.model,
      resetEpochMs: err.resetEpochMs,
      message: err.message,
    };
    host.cancel();
    return "stop";
  }
  throw err;
}

async function* finalizeToolDispatchBatch(args: {
  host: TurnLoopHost;
  controller: AbortController;
  toolCalls: ToolCall[];
  ctx: RequestContext;
  resultBlocks: ContentBlock[];
}): AsyncGenerator<AgentEvent> {
  const { host, controller, toolCalls, ctx, resultBlocks } = args;
  const seen = new Set(resultBlocks.map((b) => (b as { tool_use_id: string }).tool_use_id));
  for (const item of drainOrphanInterrupts({ toolCalls, seen })) emitQueue.emit(item);
  const queuedMessages =
    host.cancelled || controller.signal.aborted ? [] : (host.pendingUserInputDrainer?.() ?? []);
  if (queuedMessages.length > 0) resultBlocks.push(...queuedInputBlocks(queuedMessages));
  const toolLoopEndDrain = emitQueue.drainForBoundary("tool_loop_end");
  const notificationBlockTexts = new Set(
    toolLoopEndDrain.notificationTexts.map(wrapNotificationForModel),
  );
  for (const block of toolLoopEndDrain.llmBlocks) {
    if (
      queuedMessages.length === 0 &&
      block.type === "text" &&
      notificationBlockTexts.has(block.text)
    ) {
      const foldTarget = lastFoldableToolResult(resultBlocks);
      if (foldTarget !== null) {
        foldTextIntoToolResult(foldTarget, block.text);
        continue;
      }
    }
    resultBlocks.push(block);
  }
  appendNotificationRecords(host, toolLoopEndDrain.notificationTexts);
  for (const call of toolCalls) {
    if (seen.has(call.id)) continue;
    if (resultBlocks.some((b) => (b as { tool_use_id?: string }).tool_use_id === call.id)) {
      continue;
    }
    resultBlocks.push({
      type: "tool_result",
      tool_use_id: call.id,
      content: "Interrupted by user",
      is_error: true,
    });
  }
  if (!host.cancelled && !controller.signal.aborted) {
    for (const block of resultBlocks) {
      if (
        block.type === "tool_result" &&
        Array.isArray(block.content) &&
        block.content.some((part) => part.type === "image")
      ) {
        block.content = await resolveToolResultImagesForNonVision(ctx, block.content);
      }
    }
  }
  if (toolCalls.length > 0) {
    await firePostToolBatchHooks(host.deps.config, {
      kind: "postToolBatch",
      ctx: {
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
        toolCalls: toolCalls.map((call) => {
          const response = resultBlocks.find(
            (block) => block.type === "tool_result" && block.tool_use_id === call.id,
          );
          return {
            tool_name: call.name,
            tool_input: call.input,
            tool_use_id: call.id,
            ...(response?.type === "tool_result" ? { tool_response: response.content } : {}),
          };
        }),
      },
    });
  }
  if (resultBlocks.length > 0) {
    host.deps.session.messages.push({ role: "user", content: resultBlocks });
  }
  if (queuedMessages.length > 0) yield { kind: "queued_input_drained", messages: queuedMessages };
}
