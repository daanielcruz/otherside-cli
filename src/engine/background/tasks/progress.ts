import { previewArgs } from "@/engine/queue/runtime/args-preview.ts";
import type { ForkEvent } from "@/kernel/std/types/events.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  addUsage,
  appendAction,
  appendAssistantText,
  type BackgroundTask,
  completeAction,
  discardAssistantText,
  failAction,
  setForkId,
  setModel,
  setUsageSnapshot,
} from "./background.ts";

export interface SubtreeProgress {
  inputTokens: number;
  outputTokens: number;
  toolUses: number;
  tokenCount: number;
}

/** Sum tokens and tool uses for a task and every descendant under parentTaskId. */
export function aggregateSubtreeProgress(
  rootId: string,
  tasks: readonly BackgroundTask[],
): SubtreeProgress {
  const childrenByParent = new Map<string, string[]>();
  const byId = new Map<string, BackgroundTask>();
  for (const task of tasks) {
    byId.set(task.id, task);
    if (task.parentTaskId === undefined) continue;
    const list = childrenByParent.get(task.parentTaskId);
    if (list) list.push(task.id);
    else childrenByParent.set(task.parentTaskId, [task.id]);
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let toolUses = 0;
  const pending = [rootId];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const task = byId.get(id);
    if (!task) continue;
    inputTokens += task.inputTokens;
    outputTokens += task.outputTokens;
    toolUses += task.actions.length;
    const children = childrenByParent.get(id);
    if (children) {
      for (const childId of children) pending.push(childId);
    }
  }
  return {
    inputTokens,
    outputTokens,
    toolUses,
    tokenCount: inputTokens + outputTokens,
  };
}

/**
 * Resolve which background task owns a fork event. Nested agents share one
 * childTaskIdMap keyed by the Agent tool-call id that spawned them; without
 * the map every nested event collapses onto the depth-1 parent.
 */
export function resolveTaskIdForForkEvent(
  event: ForkEvent,
  fallbackTaskId: string,
  childTaskIdMap?: Map<string, string>,
): string {
  if (event.parentToolCallId === undefined || childTaskIdMap === undefined) {
    return fallbackTaskId;
  }
  return childTaskIdMap.get(event.parentToolCallId) ?? fallbackTaskId;
}

/** Ensure ctx carries a mutable childTaskIdMap so nested Agent spawns can register. */
export function ensureChildTaskIdMap(ctx: RequestContext): Map<string, string> {
  if (ctx.childTaskIdMap !== undefined) return ctx.childTaskIdMap;
  const map = new Map<string, string>();
  ctx.childTaskIdMap = map;
  return map;
}

/** Apply a live fork event onto a single background-task row. */
export function routeForkEventToTask(taskId: string, event: ForkEvent): void {
  if (event.kind === "fork_tool_dispatch_start") {
    appendAction(taskId, {
      id: event.toolCallId,
      toolName: event.toolName,
      argsLabel: previewArgs(event.input),
      running: true,
      ts: Date.now(),
    });
    return;
  }
  if (event.kind === "fork_tool_dispatch_complete") {
    if (event.isError) failAction(taskId, event.toolCallId);
    else completeAction(taskId, event.toolCallId);
    return;
  }
  if (event.kind === "fork_start") {
    setForkId(taskId, event.forkId);
    setModel(taskId, event.model, event.effort, event.provider);
    return;
  }
  if (event.kind === "fork_usage") {
    const usage = {
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheCreationInputTokens: event.cacheCreationInputTokens,
      cacheReadInputTokens: event.cacheReadInputTokens,
    };
    if (event.isSnapshot) setUsageSnapshot(taskId, usage);
    else addUsage(taskId, usage);
    return;
  }
  if (event.kind === "fork_text_delta") {
    appendAssistantText(taskId, event.text);
    return;
  }
  if (event.kind === "fork_stream_reset") {
    discardAssistantText(taskId, event.discardedChars);
  }
}
