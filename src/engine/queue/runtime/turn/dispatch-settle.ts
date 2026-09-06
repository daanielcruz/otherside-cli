import { recordPayloadDiagnostic } from "@/devtools/payload.ts";
import {
  type BackgroundTask,
  completeTask as bgCompleteTask,
  completeTaskForRun as bgCompleteTaskForRun,
  list as bgList,
  markBackgrounded as bgMarkBackgrounded,
  markTaskNotified as bgMarkTaskNotified,
  startShellTask as bgStartShellTask,
  type TaskRunRef,
} from "@/engine/background/tasks/background.ts";
import { buildAgentLaunchReceipt } from "@/engine/background/tasks/notification.ts";
import { appendRecord, nowIso } from "@/engine/session/index.ts";
import {
  archiveLargeToolOutput,
  isArchivedOutputNotice,
  outputArchiveThreshold,
} from "@/engine/tool-output-archive/index.ts";
import { generateTaskId } from "@/kernel/std/id.ts";
import { isAbortError } from "@/kernel/std/stream/abort.ts";
import type { AsyncStream } from "@/kernel/std/stream/async.ts";
import type { AgentEvent } from "@/kernel/std/types/events.ts";
import {
  type ContentBlock,
  type ToolCall,
  toolResultIsErrorField,
  toolResultText,
} from "@/kernel/std/types/message.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";
import type { TurnLoopHost } from "./types.ts";

const BASH_PROMOTION_HANDOFF_GRACE_MS = 250;

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

export function stageDispatchTaskCompletion(
  entry: DispatchEntry,
  result: Parameters<typeof bgCompleteTask>[1],
): void {
  entry.pendingTaskCompletion = result;
  if (entry.toolResultCommitted) {
    completeDispatchTask(entry, result);
    delete entry.pendingTaskCompletion;
  }
}

export function commitDispatchToolResult(entry: DispatchEntry): void {
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
    const toolResultBlock = await archiveLargeToolOutput(
      {
        type: "tool_result",
        tool_use_id: call.id,
        content: result.content,
        ...toolResultIsErrorField(result.is_error, result.meta),
      },
      call.name,
      outputArchiveThreshold(call.name),
    );
    recordPayloadDiagnostic("tool-persisted-result", toolResultBlock.content, {
      toolName: call.name,
      toolUseId: call.id,
    });
    const wasPersisted =
      isArchivedOutputNotice(toolResultBlock.content) && !isArchivedOutputNotice(result.content);
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
