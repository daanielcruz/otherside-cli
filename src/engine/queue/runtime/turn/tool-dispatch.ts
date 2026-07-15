import { recordPayloadDiagnostic } from "@/devtools/payload.ts";
import { runWithPermissionResolver } from "@/engine/agents/agent-context.ts";
import { get as getAgentDef } from "@/engine/agents/registry.ts";
import {
  type BackgroundTask,
  addUsage as bgAddUsage,
  appendAction as bgAppendAction,
  appendAssistantText as bgAppendAssistantText,
  completeAction as bgCompleteAction,
  completeTask as bgCompleteTask,
  completeTaskForRun as bgCompleteTaskForRun,
  detachTaskForRun as bgDetachTaskForRun,
  discardAssistantText as bgDiscardAssistantText,
  failAction as bgFailAction,
  list as bgList,
  markBackgrounded as bgMarkBackgrounded,
  markTaskNotified as bgMarkTaskNotified,
  setForkId as bgSetForkId,
  setModel as bgSetModel,
  setUsageSnapshot as bgSetUsageSnapshot,
  startShellTask as bgStartShellTask,
  startTask as bgStartTask,
  type TaskRunRef,
  taskRunRef,
} from "@/engine/background/tasks/background.ts";
import * as bgControllers from "@/engine/background/tasks/background-controllers.ts";
import {
  buildAgentLaunchReceipt,
  wrapNotificationForModel,
} from "@/engine/background/tasks/notification.ts";
import { listEnabledHookHandlers } from "@/engine/plugins/registry.ts";
import { QuotaExhaustedError } from "@/engine/providers/_shared/retry.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import { drainOrphanInterrupts } from "@/engine/queue/runtime/orphan-synth.ts";
import { appendRecord, nowIso } from "@/engine/session/index.ts";
import {
  foldTextIntoToolResult,
  lastFoldableToolResult,
} from "@/engine/session/transcript/tool-result-fold.ts";
import {
  getPersistenceThreshold,
  isPersistedOutputWrapper,
  maybePersistLargeToolResult,
} from "@/engine/tool-result-storage/index.ts";
import { resolveToolResultImagesForNonVision } from "@/engine/tools/builtins/image/parse-image.ts";
import { dispatch as dispatchTool } from "@/engine/tools/pipeline.ts";
import { getMaxToolUseConcurrency } from "@/kernel/config/tool-use-concurrency.ts";
import { handlersFromConfig } from "@/kernel/hooks/handler.ts";
import { generateTaskId } from "@/kernel/std/id.ts";
import { isAbortError } from "@/kernel/std/stream/abort.ts";
import { AsyncStream } from "@/kernel/std/stream/async.ts";
import type { AgentEvent, BackgroundController } from "@/kernel/std/types/events.ts";
import {
  type ContentBlock,
  type ToolCall,
  toolResultIsErrorField,
  toolResultText,
} from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";
import { previewArgs } from "../args-preview.ts";
import { partitionForConcurrency } from "../concurrency.ts";
import { mergeAsyncStreams } from "../merge-async-streams.ts";
import { collectNestedMemoryForTool } from "../nested-memory.ts";
import { resolvePermission } from "../permission-resolution.ts";
import { queuedInputBlocks } from "../turn-prompts.ts";
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

export interface DispatchEntry {
  call: ToolCall;
  queue: AsyncStream<AgentEvent>;
  abortController: AbortController;
  isAgentTool: boolean;
  isBackgroundable: boolean;
  bgTaskId: string | undefined;
  bgRun?: TaskRunRef;
  releaseController?: () => void;
  toolResultCommitted?: boolean;
  pendingTaskCompletion?: Parameters<typeof bgCompleteTask>[1];
  flags: { backgrounded: boolean; dispatchDone: boolean; settled: boolean };
  backgroundPromise: Promise<void>;
  dispatchPromise: Promise<import("@/kernel/std/types/message.ts").ToolResult>;
  outcome: Promise<DispatchOutcome>;
}

export type DispatchOutcome =
  | { kind: "backgrounded"; placeholder: string }
  | { kind: "completed"; block: ContentBlock }
  | { kind: "failed"; error: unknown };

function completeDispatchTask(
  entry: Pick<DispatchEntry, "bgRun" | "bgTaskId">,
  result: Parameters<typeof bgCompleteTask>[1],
): void {
  if (entry.bgRun !== undefined) {
    bgCompleteTaskForRun(entry.bgRun, result);
  } else if (entry.bgTaskId !== undefined) {
    bgCompleteTask(entry.bgTaskId, result);
  }
}

function stageDispatchTaskCompletion(
  entry: DispatchEntry,
  result: Parameters<typeof bgCompleteTask>[1],
): void {
  entry.pendingTaskCompletion = result;
  if (entry.toolResultCommitted) {
    completeDispatchTask(entry, result);
    delete entry.pendingTaskCompletion;
  }
}

function commitDispatchToolResult(entry: DispatchEntry): void {
  if (entry.toolResultCommitted) return;
  entry.toolResultCommitted = true;
  if (entry.pendingTaskCompletion !== undefined) {
    completeDispatchTask(entry, entry.pendingTaskCompletion);
    delete entry.pendingTaskCompletion;
  }
}

export async function settleDispatch(
  host: TurnLoopHost,
  entry: DispatchEntry,
): Promise<DispatchOutcome> {
  const { call, queue, abortController, isAgentTool, isBackgroundable, flags } = entry;
  const finish = (outcome: DispatchOutcome): DispatchOutcome => {
    flags.settled = true;
    queue.signal();
    return outcome;
  };
  try {
    if (isBackgroundable) {
      const verdict = await Promise.race([
        entry.dispatchPromise.then(() => "done" as const),
        entry.backgroundPromise.then(() => "background" as const),
      ]);
      if (verdict === "background" && flags.backgrounded && !flags.dispatchDone) {
        if (entry.bgTaskId) bgMarkBackgrounded(entry.bgTaskId);
        else if (!isAgentTool) {
          let handoffTimer: ReturnType<typeof setTimeout> | null = null;
          const handoffTimeout = new Promise<null>((resolve) => {
            handoffTimer = setTimeout(() => {
              handoffTimer = null;
              resolve(null);
            }, BASH_PROMOTION_HANDOFF_GRACE_MS);
          });
          const promotedShellId = await Promise.race([
            entry.dispatchPromise.then((result) =>
              result.meta?.kind === "bash" && result.meta.status === "background"
                ? (result.meta.shell_id ?? null)
                : null,
            ),
            handoffTimeout,
          ]).catch(() => null);
          if (handoffTimer !== null) clearTimeout(handoffTimer);
          entry.bgTaskId = promotedShellId ?? ensureBackgroundShellTask(call).id;
        }
        const llmId = entry.bgTaskId ?? call.id;
        const placeholder = isAgentTool
          ? buildAgentLaunchReceipt(llmId)
          : `Bash command moved to background.\nbashId: ${llmId}\nThe shell is still running. You will be notified automatically when it exits.\nBriefly tell the user the command is running in the background and end your response. Do not generate any other text — the result will arrive in a subsequent message.`;
        appendRecord(host.deps.session, {
          type: "tool_result",
          ts: nowIso(),
          call_id: call.id,
          result: placeholder,
          is_error: false,
        }).catch(() => {});
        entry.dispatchPromise
          .then((result) => {
            if (result.meta?.kind === "bash" && result.meta.status === "background") {
              const realId = result.meta.shell_id;
              if (entry.bgTaskId && realId !== undefined && entry.bgTaskId !== realId) {
                bgMarkTaskNotified(entry.bgTaskId);
                bgCompleteTask(entry.bgTaskId, {
                  content: `superseded by shell ${realId}`,
                  isError: false,
                  killed: true,
                });
              }
              return;
            }
            const aborted = abortController.signal.aborted;
            const text = aborted ? "Stopped by user" : toolResultText(result.content);
            const isError = aborted ? false : (result.is_error ?? false);
            if (entry.bgTaskId) {
              stageDispatchTaskCompletion(entry, {
                content: text,
                isError,
                ...(aborted ? { killed: true, userInitiated: true } : {}),
              });
            }
          })
          .catch((err) => {
            const aborted = abortController.signal.aborted || isAbortError(err);
            const msg = err instanceof Error ? err.message : String(err);
            if (entry.bgTaskId) {
              stageDispatchTaskCompletion(entry, {
                content: aborted ? "Stopped by user" : `error: ${msg}`,
                isError: !aborted,
                killed: aborted,
                ...(aborted ? { userInitiated: true } : {}),
              });
            }
          })
          .finally(() => {
            entry.releaseController?.();
          });
        queue.push({ kind: "tool_dispatch_backgrounded", id: call.id, name: call.name });
        return finish({ kind: "backgrounded", placeholder });
      }
      entry.releaseController?.();
    }

    const result = await entry.dispatchPromise;
    recordPayloadDiagnostic("tool-handler-result", result.content, {
      toolName: call.name,
      toolUseId: call.id,
    });
    if (host.cancelled) {
      return finish({ kind: "failed", error: new TurnCancelledError() });
    }
    const resultText = toolResultText(result.content);
    if (entry.bgTaskId) {
      stageDispatchTaskCompletion(entry, {
        content: resultText,
        isError: result.is_error ?? false,
      });
    }
    const toolResultBlock = await maybePersistLargeToolResult(
      {
        type: "tool_result",
        tool_use_id: call.id,
        content: result.content,
        ...toolResultIsErrorField(result.is_error, result.meta),
      },
      call.name,
      getPersistenceThreshold(call.name),
    );
    recordPayloadDiagnostic("tool-persisted-result", toolResultBlock.content, {
      toolName: call.name,
      toolUseId: call.id,
    });
    const wasPersisted =
      isPersistedOutputWrapper(toolResultBlock.content) &&
      !isPersistedOutputWrapper(result.content);
    queue.push({
      kind: "tool_dispatch_complete",
      id: call.id,
      name: call.name,
      content: toolResultText(toolResultBlock.content),
      ...(wasPersisted ? { displayContent: resultText } : {}),
      isError: result.is_error ?? false,
      ...(result.meta ? { meta: result.meta } : {}),
    });
    return finish({ kind: "completed", block: toolResultBlock });
  } catch (err) {
    return finish({ kind: "failed", error: err });
  }
}

export class TurnCancelledError extends Error {
  constructor() {
    super("Interrupted by user");
  }
}

export function ensureBackgroundShellTask(call: ToolCall): BackgroundTask {
  const existing = bgList().find((task) => task.parentToolCallId === call.id);
  if (existing) return existing;
  return bgStartShellTask({
    shellId: generateTaskId("b"),
    command: commandLabelFromInput(call.input, call.name),
    parentToolCallId: call.id,
  });
}

function commandLabelFromInput(input: unknown, fallback: string): string {
  if (isRecord(input) && typeof input.command === "string" && input.command.length > 0) {
    return input.command;
  }
  return fallback;
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
      const runInWindow = createConcurrencyWindow(getMaxToolUseConcurrency());
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
  if (resultBlocks.length > 0) {
    host.deps.session.messages.push({ role: "user", content: resultBlocks });
  }
  if (queuedMessages.length > 0) yield { kind: "queued_input_drained", messages: queuedMessages };
}
