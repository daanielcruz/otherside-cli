import type { ToolHandler } from "@/engine/tools/contract.ts";
import EnterPlanModeSchema from "@/harness/tools/EnterPlanMode/tool.json" with { type: "json" };
import ExitPlanModeSchema from "@/harness/tools/ExitPlanMode/tool.json" with { type: "json" };
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

interface ExitPlanInput {
  plan?: unknown;
}

function err(toolUseId: string, msg: string): ToolResult {
  return { tool_use_id: toolUseId, content: msg, is_error: true };
}

function ok(toolUseId: string, payload: unknown): ToolResult {
  return { tool_use_id: toolUseId, content: JSON.stringify(payload) };
}

function isSubagent(ctx: RequestContext): boolean {
  return typeof ctx.parentThreadId === "string" && ctx.parentThreadId.length > 0;
}

export const EnterPlanMode: ToolHandler = {
  schema: EnterPlanModeSchema,
  render: { isTransparent: () => true },
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    if (isSubagent(ctx)) {
      return ok(call.id, {
        entered: false,
        reason: "subagent plan mode is leader-only; ignored in subagent context",
      });
    }
    const broker = ctx.broker;
    if (!broker) return err(call.id, "broker not initialized");
    const state = broker.read();
    if (state.permissionMode === "plan") {
      return ok(call.id, { entered: false, reason: "already in plan mode" });
    }
    broker.dispatch({ kind: "set_permission_mode", mode: "plan" });
    return ok(call.id, {
      entered: true,
      previousMode: state.permissionMode,
      message:
        "Plan mode active. Mutating tools (Edit, Write, Bash) are blocked until ExitPlanMode.",
    });
  },
};

export const ExitPlanMode: ToolHandler = {
  schema: ExitPlanModeSchema,
  render: { isTransparent: () => true },
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    if (isSubagent(ctx)) {
      return ok(call.id, {
        exited: false,
        reason: "plan mode is leader-only; subagent cannot exit parent's mode",
      });
    }
    const broker = ctx.broker;
    if (!broker) return err(call.id, "broker not initialized");
    const state = broker.read();
    const args = (call.input ?? {}) as ExitPlanInput;
    const plan = typeof args.plan === "string" ? args.plan : null;
    if (state.permissionMode === "plan") {
      const restoreMode = state.prePlanMode ?? "default";
      broker.dispatch({ kind: "set_permission_mode", mode: restoreMode });
      return ok(call.id, {
        exited: true,
        mode: restoreMode,
        ...(plan ? { plan } : {}),
      });
    }
    return ok(call.id, {
      exited: true,
      mode: state.permissionMode,
      ...(plan ? { plan } : {}),
    });
  },
};
