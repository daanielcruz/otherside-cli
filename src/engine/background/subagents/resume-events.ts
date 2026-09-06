import {
  addUsage,
  appendAction,
  appendAssistantText,
  type BackgroundTask,
  completeAction,
  discardAssistantText,
  failAction,
  get as getBackgroundTask,
  setRoute,
  setUsageSnapshot,
  type TaskRunRef,
} from "@/engine/background/tasks/background.ts";
import { previewArgs } from "@/engine/queue/runtime/args-preview.ts";
import type { ForkEvent } from "@/kernel/std/types/events.ts";

export function activeTaskForRun(run: TaskRunRef): BackgroundTask | undefined {
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

export function routeResumedEvent(run: TaskRunRef, event: ForkEvent): void {
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
