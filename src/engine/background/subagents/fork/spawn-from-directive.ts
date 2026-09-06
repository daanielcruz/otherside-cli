import type { PermissionResolver } from "@/engine/agents/agent-context.ts";
import { runWithPermissionResolver } from "@/engine/agents/agent-context.ts";
import {
  completeTask,
  setForkId,
  startTask,
  taskRunRef,
} from "@/engine/background/tasks/background.ts";
import * as backgroundControllers from "@/engine/background/tasks/background-controllers.ts";
import {
  ensureChildTaskIdMap,
  resolveTaskIdForForkEvent,
  routeForkEventToTask,
} from "@/engine/background/tasks/progress.ts";
import type { BackgroundController, ForkEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { deriveForkName, forkDescriptionFromDirective } from "./derive-name.ts";
import { dispatchFork } from "./spawn.ts";
import { isRootAgentRun } from "./spawn-depth.ts";

export interface SpawnForkFromDirectiveResult {
  agentId: string;
  name: string;
}

export const FORK_GLYPH = "⑂";

export function hasConversationTurn(messages: readonly Message[]): boolean {
  return messages.some((message) => message.role === "user");
}

/**
 * Spawn a detached background fork that inherits the parent conversation.
 * Returns null when the host has no conversation turn to inherit.
 * The run is fire-and-forget: the caller gets `{ name, agentId }` immediately.
 */
export function launchForkFromDirective(
  directive: string,
  ctx: RequestContext,
  permissionResolver?: PermissionResolver,
): SpawnForkFromDirectiveResult | null {
  if (!isRootAgentRun(ctx)) return null;
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
    route: { provider: ctx.provider, model: ctx.model },
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
  // Nested Agent spawns under this fork register into the same map so their
  // tool/token events land on the grandchild row instead of the depth-1 parent.
  const childTaskIdMap = ensureChildTaskIdMap(ctx);

  const eventSink = (event: ForkEvent): void => {
    const taskId = resolveTaskIdForForkEvent(event, agentId, childTaskIdMap);
    routeForkEventToTask(taskId, event);
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
        childTaskIdMap,
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
  return [
    `forked into a background agent · ${result.name} (${result.agentId.slice(-4)})`,
    "it carries this conversation up to now and is already working · nothing here changes",
    "track it in the agents panel (↓ to manage) · its result lands here as a notification when it completes",
  ].join("\n");
}
