import type { BackgroundTask } from "@/engine/background/tasks/background.ts";
import * as bgTasks from "@/engine/background/tasks/background.ts";
import type { TaskRecord } from "@/engine/background/tasks/index.ts";
import * as tasks from "@/engine/background/tasks/index.ts";
import { formatTaskOutput } from "@/engine/background/tasks/output-files.ts";
import { persistWorkflowRun } from "@/engine/background/workflows/runtime/history/snapshot.ts";
import { formatWorkflowTaskOutput } from "@/engine/background/workflows/runtime/store/output.ts";
import {
  getWorkflowTask,
  killWorkflowTask,
} from "@/engine/background/workflows/runtime/store/store.ts";
import { killBackground } from "@/engine/tools/builtins/background.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import TaskCreateSchema from "@/harness/tools/TaskCreate/tool.json" with { type: "json" };
import TaskGetSchema from "@/harness/tools/TaskGet/tool.json" with { type: "json" };
import TaskListSchema from "@/harness/tools/TaskList/tool.json" with { type: "json" };
import TaskOutputSchema from "@/harness/tools/TaskOutput/tool.json" with { type: "json" };
import TaskStopSchema from "@/harness/tools/TaskStop/tool.json" with { type: "json" };
import TaskUpdateSchema from "@/harness/tools/TaskUpdate/tool.json" with { type: "json" };
import { fireTaskHook } from "@/kernel/hooks/handler.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  coerceTaskCreateInput,
  coerceTaskGetInput,
  coerceTaskOutputInput,
  coerceTaskStopInput,
  coerceTaskUpdateInput,
  steerTaskCreateValidation,
} from "./task-input.ts";

interface TaskCreateInput {
  subject?: unknown;
  description?: unknown;
  activeForm?: unknown;
  metadata?: unknown;
}

interface TaskIdInput {
  taskId?: unknown;
}

interface TaskWireIdInput {
  task_id?: unknown;
  shell_id?: unknown;
}

interface TaskUpdateInput {
  taskId?: unknown;
  subject?: unknown;
  description?: unknown;
  activeForm?: unknown;
  status?: unknown;
  owner?: unknown;
  addBlocks?: unknown;
  addBlockedBy?: unknown;
  metadata?: unknown;
}

function err(toolUseId: string, msg: string): ToolResult {
  return { tool_use_id: toolUseId, content: msg, is_error: true };
}

function okText(toolUseId: string, text: string): ToolResult {
  return { tool_use_id: toolUseId, content: text };
}

export const TaskCreate: ToolHandler = {
  schema: {
    name: TaskCreateSchema.name,
    description: TaskCreateSchema.description,
    inputSchema: TaskCreateSchema.inputSchema,
  },
  coerceInput: coerceTaskCreateInput,
  steerValidationError: steerTaskCreateValidation,
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as TaskCreateInput;
    const subject = typeof args.subject === "string" ? args.subject : null;
    const description = typeof args.description === "string" ? args.description : null;
    if (!subject) return err(call.id, "subject is required");
    if (!description) return err(call.id, "description is required");
    const activeForm = typeof args.activeForm === "string" ? args.activeForm : undefined;
    const metadata =
      args.metadata !== null && typeof args.metadata === "object" && !Array.isArray(args.metadata)
        ? (args.metadata as Record<string, unknown>)
        : undefined;
    // Planning tasks are shared by the whole session. `owner` remains a field
    // on each record; the executing agent does not define list visibility.
    const rec = tasks.create({
      subject,
      description,
      ...(activeForm !== undefined ? { activeForm } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    });
    const blocked = await fireTaskHook({
      event: "taskCreated",
      ctx,
      taskId: rec.id,
      subject: rec.subject,
      description: rec.description,
    });
    if (blocked) {
      tasks.remove(rec.id);
      return err(call.id, blocked);
    }
    return okText(call.id, `Task #${rec.id} created successfully: ${rec.subject}`);
  },
};

export const TaskList: ToolHandler = {
  schema: {
    name: TaskListSchema.name,
    description: TaskListSchema.description,
    inputSchema: TaskListSchema.inputSchema,
  },
  isConcurrencySafe: true,
  async run(call: ToolCall, _ctx: RequestContext): Promise<ToolResult> {
    const all = tasks.list();
    const resolvedTaskIds = new Set(all.filter((t) => t.status === "completed").map((t) => t.id));
    const listed = all.filter((t) => !t.metadata._internal);
    if (listed.length === 0) return okText(call.id, "No tasks found");
    const lines = listed.map((t) => {
      const owner = t.owner ? ` (${t.owner})` : "";
      const blockedBy = t.blockedBy.filter((id) => !resolvedTaskIds.has(id));
      const blocked =
        blockedBy.length > 0 ? ` [blocked by ${blockedBy.map((id) => `#${id}`).join(", ")}]` : "";
      return `#${t.id} [${t.status}] ${t.subject}${owner}${blocked}`;
    });
    return okText(call.id, lines.join("\n"));
  },
};

export const TaskGet: ToolHandler = {
  schema: {
    name: TaskGetSchema.name,
    description: TaskGetSchema.description,
    inputSchema: TaskGetSchema.inputSchema,
  },
  isConcurrencySafe: true,
  coerceInput: coerceTaskGetInput,
  async run(call: ToolCall, _ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as TaskIdInput;
    const taskId = typeof args.taskId === "string" ? args.taskId : null;
    if (!taskId) return err(call.id, "taskId is required");
    const t = tasks.get(taskId);
    if (!t) return okText(call.id, "Task not found");
    const lines = [
      `Task #${t.id}: ${t.subject}`,
      `Status: ${t.status}`,
      `Description: ${t.description}`,
    ];
    if (t.blockedBy.length > 0) {
      lines.push(`Blocked by: ${t.blockedBy.map((id) => `#${id}`).join(", ")}`);
    }
    if (t.blocks.length > 0) {
      lines.push(`Blocks: ${t.blocks.map((id) => `#${id}`).join(", ")}`);
    }
    return okText(call.id, lines.join("\n"));
  },
};

export const TaskUpdate: ToolHandler = {
  schema: {
    name: TaskUpdateSchema.name,
    description: TaskUpdateSchema.description,
    inputSchema: TaskUpdateSchema.inputSchema,
  },
  isConcurrencySafe: true,
  coerceInput: coerceTaskUpdateInput,
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as TaskUpdateInput;
    const taskId = typeof args.taskId === "string" ? args.taskId : null;
    if (!taskId) return err(call.id, "taskId is required");

    if (args.status === "deleted") {
      const existed = tasks.remove(taskId);
      return okText(
        call.id,
        existed ? `Updated task #${taskId} deleted` : `Task #${taskId} not found`,
      );
    }

    const cur = tasks.get(taskId);
    if (!cur) {
      return okText(call.id, `Task #${taskId} not found`);
    }

    const owner = typeof args.owner === "string" ? args.owner : undefined;
    const updated: string[] = [];
    const patch: Partial<TaskRecord> = {};

    if (typeof args.subject === "string" && args.subject !== cur.subject) {
      patch.subject = args.subject;
      updated.push("subject");
    }
    if (typeof args.description === "string" && args.description !== cur.description) {
      patch.description = args.description;
      updated.push("description");
    }
    if (typeof args.activeForm === "string" && args.activeForm !== (cur.activeForm ?? "")) {
      patch.activeForm = args.activeForm;
      updated.push("activeForm");
    }
    if (owner !== undefined && owner !== cur.owner) {
      patch.owner = owner;
      updated.push("owner");
    }
    if (typeof args.status === "string") {
      if (!tasks.isValidStatus(args.status)) {
        return err(
          call.id,
          `unknown status \`${args.status}\` (valid: pending, in_progress, completed, deleted)`,
        );
      }
      if (args.status !== cur.status) {
        patch.status = args.status;
        updated.push("status");
      }
    }
    const blockEdges: Array<[string, string]> = [];
    if (Array.isArray(args.addBlocks)) {
      for (const v of args.addBlocks) {
        if (typeof v === "string" && v !== taskId) blockEdges.push([taskId, v]);
      }
    }
    if (Array.isArray(args.addBlockedBy)) {
      for (const v of args.addBlockedBy) {
        if (typeof v === "string" && v !== taskId) blockEdges.push([v, taskId]);
      }
    }
    if (
      args.metadata !== null &&
      typeof args.metadata === "object" &&
      !Array.isArray(args.metadata)
    ) {
      const merged: Record<string, unknown> = { ...cur.metadata };
      let changed = false;
      for (const [k, v] of Object.entries(args.metadata as Record<string, unknown>)) {
        if (v === null) {
          if (k in merged) {
            delete merged[k];
            changed = true;
          }
        } else if (merged[k] !== v) {
          merged[k] = v;
          changed = true;
        }
      }
      if (changed) {
        patch.metadata = merged;
        updated.push("metadata");
      }
    }

    if (patch.status === "completed") {
      const blocked = await fireTaskHook({
        event: "taskCompleted",
        ctx,
        taskId: cur.id,
        subject: cur.subject,
        description: cur.description,
      });
      if (blocked) return err(call.id, blocked);
    }

    if (Object.keys(patch).length > 0) {
      tasks.updateTaskRecord(taskId, patch);
    }

    let blocksChanged = false;
    let blockedByChanged = false;
    for (const [fromId, toId] of blockEdges) {
      if (tasks.block(fromId, toId)) {
        if (fromId === taskId) blocksChanged = true;
        else blockedByChanged = true;
      }
    }
    if (blocksChanged) updated.push("blocks");
    if (blockedByChanged) updated.push("blockedBy");

    const fieldsText = updated.length > 0 ? updated.join(", ") : "no changes";
    return okText(call.id, `Updated task #${taskId} ${fieldsText}`);
  },
};

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
    const combined = formatTaskOutput(input.output, input.taskId).content;
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
