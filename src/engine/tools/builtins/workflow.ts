import { launchWorkflow } from "@/engine/background/workflows/runtime/launch/launcher.ts";
import { getWorkflowToolUseSummary } from "@/engine/background/workflows/runtime/transcript/tool-use-summary.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import WorkflowSchema from "@/harness/tools/Workflow/tool.json" with { type: "json" };
import { errorMessage } from "@/kernel/std/errno.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export const Workflow: ToolHandler = {
  schema: WorkflowSchema,
  isConcurrencySafe: true,
  render: {
    userFacingName() {
      return "Workflow";
    },
    summarizeArgs(input) {
      return getWorkflowToolUseSummary(input, { verbose: true });
    },
  },
  async run(call: ToolCall, ctx: RequestContext): Promise<ToolResult> {
    try {
      const outcome = await launchWorkflow(call.input, ctx, call.id);
      if (!outcome.ok) return { tool_use_id: call.id, content: outcome.error, is_error: true };
      return { tool_use_id: call.id, content: outcome.message };
    } catch (error) {
      const message = errorMessage(error);
      return { tool_use_id: call.id, content: message, is_error: true };
    }
  },
};
