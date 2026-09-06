import type { TaskRecord } from "@/engine/background/tasks/index.ts";
import * as tasks from "@/engine/background/tasks/index.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import TaskCreateSchema from "@/harness/tools/TaskCreate/tool.json" with { type: "json" };
import TaskGetSchema from "@/harness/tools/TaskGet/tool.json" with { type: "json" };
import TaskListSchema from "@/harness/tools/TaskList/tool.json" with { type: "json" };
import TaskUpdateSchema from "@/harness/tools/TaskUpdate/tool.json" with { type: "json" };
import { fireTaskHook } from "@/kernel/hooks/handler.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import {
  coerceTaskCreateInput,
  coerceTaskGetInput,
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

/**
 * Which planning list a task tool works. A fork plans in its own: that is the list
 * the footer shows while the fork's document is open, and the list its teardown
 * drops when it ends. The main conversation carries no agent id and works the
 * session's own list, which a fork's planning must never reach.
 */
function taskScopeFor(ctx: RequestContext): tasks.Scope {
  return ctx.agentId ?? tasks.MAIN_TASK_SCOPE;
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
    const scope = taskScopeFor(ctx);
    const rec = tasks.create(
      {
        subject,
        description,
        ...(activeForm !== undefined ? { activeForm } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      },
      scope,
    );
    const blocked = await fireTaskHook({
      event: "taskCreated",
      ctx,
      taskId: rec.id,
      subject: rec.subject,
      description: rec.description,
    });
    if (blocked) {
      tasks.remove(rec.id, scope);
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
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const all = tasks.list(taskScopeFor(ctx));
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
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as TaskIdInput;
    const taskId = typeof args.taskId === "string" ? args.taskId : null;
    if (!taskId) return err(call.id, "taskId is required");
    const t = tasks.get(taskId, taskScopeFor(ctx));
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

    const scope = taskScopeFor(ctx);
    // Existence is checked before any status handling (including
    // deletes), and the not-found text carries no task id.
    const cur = tasks.get(taskId, scope);
    if (!cur) {
      return okText(call.id, "Task not found");
    }

    if (args.status === "deleted") {
      const removed = tasks.remove(taskId, scope);
      return okText(call.id, removed ? `Updated task #${taskId} deleted` : "Failed to delete task");
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
    // A provided metadata object always merges and always counts as
    // an updated field (even when the merge is a no-op), recorded before the
    // status field in the result text.
    if (
      args.metadata !== null &&
      typeof args.metadata === "object" &&
      !Array.isArray(args.metadata)
    ) {
      const merged: Record<string, unknown> = { ...cur.metadata };
      for (const [k, v] of Object.entries(args.metadata as Record<string, unknown>)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      patch.metadata = merged;
      updated.push("metadata");
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

    // The patch and its edges land together: a failure part-way through would
    // otherwise leave the graph describing a dependency only one of its two tasks
    // knows about.
    const outcome = tasks.applyTaskUpdate(taskId, patch, blockEdges, scope);
    if (!outcome) return err(call.id, `task #${taskId} not found`);
    if (outcome.blocksChanged) updated.push("blocks");
    if (outcome.blockedByChanged) updated.push("blockedBy");

    // An empty update joins to an empty field list, producing
    // "Updated task #N " with a trailing space.
    return okText(call.id, `Updated task #${taskId} ${updated.join(", ")}`);
  },
};
