import {
  cancelTaskTree as bgCancelTaskTree,
  completeTaskForRun as bgCompleteTaskForRun,
  detachTaskForRun as bgDetachTaskForRun,
  type TaskCompletion,
  type TaskRunRef,
} from "@/engine/background/tasks/background.ts";
import * as bgControllers from "@/engine/background/tasks/background-controllers.ts";
import { buildAgentLaunchReceipt } from "@/engine/background/tasks/notification.ts";
import { AbortError, isAbortError, linkAbort } from "@/kernel/std/stream/abort.ts";
import type { BackgroundController } from "@/kernel/std/types/events.ts";
import { type ToolResult, toolResultText } from "@/kernel/std/types/message.ts";

export interface NestedControllerRegistration {
  controller: BackgroundController;
  abortController: AbortController;
  release: () => void;
}

export function createNestedBackgroundController(
  callId: string,
  run: TaskRunRef,
  parentSignal: AbortSignal | undefined,
): NestedControllerRegistration {
  let backgrounded = false;
  let resolve: (() => void) | undefined;
  let released = false;
  const abortController = new AbortController();
  const detachParentAbort = linkAbort(abortController, parentSignal);
  const signaled = new Promise<void>((done) => {
    resolve = done;
  });
  let releaseRegistration = (): void => {};
  const release = (): void => {
    if (released) return;
    released = true;
    detachParentAbort();
    releaseRegistration();
  };
  const controller: BackgroundController = {
    signal: () => {
      if (backgrounded) return;
      backgrounded = true;
      detachParentAbort();
      bgDetachTaskForRun(run);
      resolve?.();
    },
    isBackgrounded: () => backgrounded,
    abort: () => abortController.abort(new AbortError()),
    taskId: run.taskId,
    signaled,
  };
  releaseRegistration = bgControllers.register(callId, controller);
  return { controller, abortController, release };
}

export interface NestedCompletionGate {
  commit: () => void;
}

export function createNestedCompletionGate(
  run: TaskRunRef,
  completion: Promise<ToolResult>,
): NestedCompletionGate {
  let committed = false;
  let settled: TaskCompletion | undefined;
  const publish = (): void => {
    if (settled === undefined || !committed) return;
    bgCompleteTaskForRun(run, settled);
  };
  void completion.then(
    (result) => {
      settled = {
        content: toolResultText(result.content),
        isError: result.is_error === true,
      };
      publish();
    },
    (reason: unknown) => {
      if (isAbortError(reason)) {
        bgCancelTaskTree(run, {
          reason: reason instanceof Error ? reason.message : "aborted",
          suppressRootNotification: true,
        });
        return;
      }
      settled = {
        content: reason instanceof Error ? reason.message : String(reason),
        isError: true,
      };
      publish();
    },
  );
  return {
    commit: () => {
      if (committed) return;
      committed = true;
      publish();
    },
  };
}

export function detachNestedAgent(
  dispatched: Promise<ToolResult>,
  controller: BackgroundController,
  taskId: string | undefined,
  toolUseId: string,
): Promise<ToolResult> {
  return Promise.race([
    dispatched,
    controller.signaled!.then(() => ({
      tool_use_id: toolUseId,
      content: buildAgentLaunchReceipt(taskId ?? "unknown"),
    })),
  ]);
}
