import type { PermissionResolver } from "@/engine/agents/agent-context.ts";
import { runWithPermissionResolver } from "@/engine/agents/agent-context.ts";
import {
  addUsage,
  appendAction,
  appendAssistantText,
  completeAction,
  completeTask,
  discardAssistantText,
  failAction,
  setForkId,
  setModel,
  setUsageSnapshot,
  startTask,
  taskRunRef,
} from "@/engine/background/tasks/background.ts";
import * as backgroundControllers from "@/engine/background/tasks/background-controllers.ts";
import { previewArgs } from "@/engine/queue/runtime/args-preview.ts";
import type { BackgroundController, ForkEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { deriveForkName, forkDescriptionFromDirective } from "./derive-name.ts";
import { dispatchFork } from "./spawn.ts";
import { isMainAgentContext } from "./spawn-depth.ts";

export interface SpawnForkFromDirectiveResult {
  agentId: string;
  name: string;
}

export const FORK_GLYPH = "⑂";

export function hasConversationTurn(messages: readonly Message[]): boolean {
  return messages.some((message) => message.role === "user");
}

function routeTaskEvent(taskId: string, event: ForkEvent): void {
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

/**
 * Spawn a detached background fork that inherits the parent conversation.
 * Returns null when the host has no conversation turn to inherit.
 * The run is fire-and-forget: the caller gets `{ name, agentId }` immediately.
 */
export function spawnForkFromDirective(
  directive: string,
  ctx: RequestContext,
  permissionResolver?: PermissionResolver,
): SpawnForkFromDirectiveResult | null {
  if (!isMainAgentContext(ctx)) return null;
  const parent = ctx.parentMessages ?? [];
  if (!hasConversationTurn(parent)) return null;

  const name = deriveForkName(directive);
  const description = forkDescriptionFromDirective(directive);
  const task = startTask({
    parentToolCallId: `slash-fork:${name}`,
    agentName: name,
    agentId: "fork",
    description,
    prompt: directive,
    provider: ctx.provider,
    model: ctx.model,
    cwd: ctx.originalCwd ?? ctx.cwd,
    sessionId: ctx.sessionId,
    isBackgrounded: true,
    lifecycleMode: "detached",
  });
  const agentId = task.id;
  setForkId(agentId, agentId);
  const runRef = taskRunRef(task);
  const abortController = new AbortController();
  const taskController: BackgroundController = {
    taskId: agentId,
    signal: () => {},
    isBackgrounded: () => true,
    abort: () => abortController.abort(),
  };
  const releaseController = backgroundControllers.register(task.parentToolCallId, taskController);

  const eventSink = (event: ForkEvent): void => {
    routeTaskEvent(agentId, event);
    ctx.eventSink?.(event);
  };

  const launch = (): Promise<void> =>
    dispatchFork(
      {
        directive,
        description,
        name,
        runInBackground: true,
        forkId: agentId,
        parentToolCallId: task.parentToolCallId,
        permissionMode: ctx.permissionMode,
      },
      {
        ...ctx,
        parentMessages: parent,
        bgTaskId: agentId,
        abortSignal: abortController.signal,
        eventSink,
      },
    )
      .then((result) => {
        completeTask(runRef.taskId, {
          content: result.output,
          isError: result.isError,
        });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        completeTask(runRef.taskId, {
          content: message,
          isError: true,
        });
      })
      .finally(releaseController);

  if (permissionResolver) {
    void runWithPermissionResolver(permissionResolver, launch);
  } else {
    void launch();
  }

  return { agentId, name };
}

export function formatForkSuccessFeedback(result: SpawnForkFromDirectiveResult): string {
  return `${FORK_GLYPH} forked ${result.name} (${result.agentId.slice(-4)})`;
}
