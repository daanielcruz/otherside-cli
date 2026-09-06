import type { BackgroundTask } from "@/engine/background/tasks/background.ts";
import * as bgTasks from "@/engine/background/tasks/background.ts";
import { renderTaskResultForMessage } from "@/engine/background/tasks/output-files.ts";
import { persistWorkflowRun } from "@/engine/background/workflows/runtime/history/snapshot.ts";
import { formatWorkflowTaskOutput } from "@/engine/background/workflows/runtime/store/output.ts";
import {
  getWorkflowTask,
  killWorkflowTask,
} from "@/engine/background/workflows/runtime/store/store.ts";
import { killBackground } from "@/engine/tools/builtins/background.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import TaskOutputSchema from "@/harness/tools/TaskOutput/tool.json" with { type: "json" };
import TaskStopSchema from "@/harness/tools/TaskStop/tool.json" with { type: "json" };
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { coerceTaskOutputInput, coerceTaskStopInput } from "./task-input.ts";

interface TaskWireIdInput {
  task_id?: unknown;
  shell_id?: unknown;
}

function err(toolUseId: string, msg: string): ToolResult {
  return { tool_use_id: toolUseId, content: msg, is_error: true };
}

function okText(toolUseId: string, text: string): ToolResult {
  return { tool_use_id: toolUseId, content: text };
}

function stoppedTaskResult(taskId: string, taskType: string, command: string): string {
  return JSON.stringify({
    message: `Successfully stopped task: ${taskId} (${command})`,
    task_id: taskId,
    task_type: taskType,
    command,
  });
}

function resolveBackgroundTask(idOrName: string): { task?: BackgroundTask; error?: string } {
  const exact = bgTasks.get(idOrName);
  if (exact) return { task: exact };

  const matches = bgTasks
    .list()
    .filter(
      (task) =>
        task.kind === "agent" &&
        task.status === "running" &&
        (task.agentName === idOrName || task.agentId === idOrName),
    );
  if (matches.length === 1) return { task: matches[0]! };
  if (matches.length > 1) {
    return {
      error: `Multiple running agents match "${idOrName}": ${matches.map((task) => task.id).join(", ")}. Use the task ID.`,
    };
  }
  return {};
}

export const TaskStop: ToolHandler = {
  schema: {
    name: TaskStopSchema.name,
    description: TaskStopSchema.description,
    inputSchema: TaskStopSchema.inputSchema,
  },
  isConcurrencySafe: true,
  coerceInput: coerceTaskStopInput,
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as TaskWireIdInput;
    const taskId =
      typeof args.task_id === "string"
        ? args.task_id
        : typeof args.shell_id === "string"
          ? args.shell_id
          : null;
    if (!taskId) return err(call.id, "task_id is required");
    const bgLookup = resolveBackgroundTask(taskId);
    if (bgLookup.error) return err(call.id, bgLookup.error);
    const bgTask = bgLookup.task;
    if (bgTask) {
      const resolvedTaskId = bgTask.id;
      const parkedAgent =
        bgTask.kind === "agent" &&
        bgTask.status === "completed" &&
        bgTasks.hasRunningAgentDescendant(resolvedTaskId);
      if (bgTask.status !== "running" && !parkedAgent) {
        return err(call.id, `Task ${resolvedTaskId} is not running (status: ${bgTask.status})`);
      }
      if (ctx.agentOwnerId !== undefined && bgTask.ownerId !== ctx.agentOwnerId) {
        const ownerLabel =
          bgTask.ownerId === undefined ? "the main session" : `agent ${bgTask.ownerId}`;
        return err(
          call.id,
          `Task ${resolvedTaskId} is owned by ${ownerLabel}; agent ${ctx.agentOwnerId} cannot stop it.`,
        );
      }
      if (bgTask.kind === "shell") {
        const killed = killBackground(resolvedTaskId);
        if ("error" in killed) return err(call.id, killed.error);
        bgTasks.completeTask(resolvedTaskId, {
          content: "Killed by parent agent",
          isError: false,
          killed: true,
        });
      } else {
        bgTasks.cancelTaskTree(bgTasks.taskRunRef(bgTask), {
          reason: "Killed by parent agent",
          ...(parkedAgent ? { includeDetached: true, suppressRootNotification: true } : {}),
        });
      }
      return okText(
        call.id,
        stoppedTaskResult(
          resolvedTaskId,
          bgTaskTypeLabel(bgTask),
          bgTask.command ?? bgTask.description ?? bgTask.agentName,
        ),
      );
    }
    const workflowTask = getWorkflowTask(taskId);
    if (workflowTask) {
      if (workflowTask.status !== "running" && workflowTask.status !== "paused") {
        return err(call.id, `Task ${taskId} is not running (status: ${workflowTask.status})`);
      }
      if (ctx.agentOwnerId !== undefined && workflowTask.ownerId !== ctx.agentOwnerId) {
        const ownerLabel =
          workflowTask.ownerId === undefined ? "the main session" : `agent ${workflowTask.ownerId}`;
        return err(
          call.id,
          `Task ${taskId} is owned by ${ownerLabel}; agent ${ctx.agentOwnerId} cannot stop it.`,
        );
      }
      // TaskStop is always invoked as a tool call the model itself makes —
      // there is no code path where a literal user action reaches this
      // handler directly (a real user-driven kill goes through the
      // keybinding that calls killWorkflowTask itself) — so this stop is
      // never user-initiated.
      killWorkflowTask(taskId);
      const postTask = getWorkflowTask(taskId);
      if (postTask) {
        await persistWorkflowRun({
          cwd: ctx.cwd,
          sessionId: ctx.sessionId,
          runId: workflowTask.workflowRunId,
          task: postTask,
        });
      }
      return okText(
        call.id,
        stoppedTaskResult(
          taskId,
          "local_workflow",
          workflowTask.description ?? workflowTask.workflowName,
        ),
      );
    }
    return err(call.id, `No task found with ID: ${taskId}`);
  },
};

interface TaskOutputInput {
  task_id?: unknown;
  shell_id?: unknown;
  block?: unknown;
  timeout?: unknown;
}

const POLL_INTERVAL_MS = 100;
const DEFAULT_BLOCK_TIMEOUT_MS = 30_000;
const MAX_BLOCK_TIMEOUT_MS = 600_000;

function escapeXmlInline(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildTaskOutputXml(input: {
  retrievalStatus: "success" | "timeout" | "not_ready" | "not_found";
  taskId: string;
  taskType?: string;
  status?: string;
  output?: string;
  error?: string;
  exitCode?: number;
}): string {
  const lines: string[] = [`<retrieval_status>${input.retrievalStatus}</retrieval_status>`];
  lines.push("");
  lines.push(`<task_id>${input.taskId}</task_id>`);
  if (input.taskType !== undefined) lines.push(`<task_type>${input.taskType}</task_type>`);
  if (input.status !== undefined) lines.push(`<status>${input.status}</status>`);
  if (input.exitCode !== undefined) lines.push(`<exit_code>${input.exitCode}</exit_code>`);
  if (input.output !== undefined) {
    const combined = renderTaskResultForMessage(input.output, input.taskId).textForModel;
    lines.push("");
    lines.push("<output>");
    lines.push(escapeXmlInline(combined.trimEnd()));
    lines.push("</output>");
  }
  if (input.error !== undefined) {
    lines.push("");
    lines.push(`<error>${escapeXmlInline(input.error)}</error>`);
  }
  return lines.join("\n");
}

function bgTaskStatusLabel(task: ReturnType<typeof bgTasks.get>): string {
  if (!task) return "unknown";
  if (task.status === "running") return "running";
  if (task.status === "error") return "failed";
  return task.status;
}

function bgTaskTypeLabel(task: ReturnType<typeof bgTasks.get>): string {
  if (!task) return "unknown";
  return task.kind === "shell" ? "local_bash" : "local_agent";
}

function bgTaskOutput(task: ReturnType<typeof bgTasks.get>): string {
  if (!task) return "";
  if (task.kind === "shell") {
    if (task.status === "running") return task.shellOutput;
    return task.result?.content ?? task.shellOutput;
  }
  if (task.result?.content) return task.result.content;
  return task.assistantText;
}

function taskOutputAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("TaskOutput aborted");
  error.name = "AbortError";
  return error;
}

function waitForPoll(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => finish(taskOutputAbortError(signal!));

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(), POLL_INTERVAL_MS);
  });
}

async function waitForBgCompletion(
  taskId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = bgTasks.get(taskId);
    if (!t) return;
    if (t.status !== "running") return;
    await waitForPoll(signal);
  }
}

async function waitForWorkflowCompletion(
  taskId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = getWorkflowTask(taskId);
    if (!task) return;
    if (task.status !== "running" && task.status !== "paused") return;
    await waitForPoll(signal);
  }
}

export const TaskOutput: ToolHandler = {
  schema: {
    name: TaskOutputSchema.name,
    description: TaskOutputSchema.description,
    inputSchema: TaskOutputSchema.inputSchema,
  },
  isConcurrencySafe: true,
  coerceInput: coerceTaskOutputInput,
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as TaskOutputInput;
    const taskId =
      typeof args.task_id === "string"
        ? args.task_id
        : typeof args.shell_id === "string"
          ? args.shell_id
          : null;
    if (!taskId) return err(call.id, "`task_id` is required");
    const block = typeof args.block === "boolean" ? args.block : true;
    const rawTimeout = typeof args.timeout === "number" ? args.timeout : DEFAULT_BLOCK_TIMEOUT_MS;
    const timeoutMs = Math.max(0, Math.min(rawTimeout, MAX_BLOCK_TIMEOUT_MS));

    const bgInitial = bgTasks.get(taskId);
    if (bgInitial !== undefined) {
      if (block && bgInitial.status === "running") {
        await waitForBgCompletion(taskId, timeoutMs, ctx.abortSignal);
      }
      const t = bgTasks.get(taskId);
      const stillRunning = t?.status === "running";
      const exitCode = t?.kind === "shell" ? t.exitCode : undefined;
      return {
        tool_use_id: call.id,
        content: buildTaskOutputXml({
          retrievalStatus: stillRunning ? (block ? "timeout" : "not_ready") : "success",
          taskId,
          taskType: bgTaskTypeLabel(t),
          status: bgTaskStatusLabel(t),
          output: bgTaskOutput(t),
          ...(exitCode !== undefined ? { exitCode } : {}),
        }),
      };
    }

    const workflowInitial = getWorkflowTask(taskId);
    if (workflowInitial !== undefined) {
      if (block && (workflowInitial.status === "running" || workflowInitial.status === "paused")) {
        await waitForWorkflowCompletion(taskId, timeoutMs, ctx.abortSignal);
      }
      const workflowTask = getWorkflowTask(taskId);
      const stillRunning = workflowTask?.status === "running" || workflowTask?.status === "paused";
      return {
        tool_use_id: call.id,
        content: buildTaskOutputXml({
          retrievalStatus: stillRunning ? (block ? "timeout" : "not_ready") : "success",
          taskId,
          taskType: "local_workflow",
          status: workflowTask?.status ?? "unknown",
          output: workflowTask ? formatWorkflowTaskOutput(workflowTask) : "",
        }),
      };
    }

    return err(call.id, `No task found with ID: ${taskId}`);
  },
};
