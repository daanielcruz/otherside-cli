import type { ToolHandler } from "@/engine/tools/contract.ts";
import ReportFindingsSchema from "@/harness/tools/ReportFindings/tool.json" with { type: "json" };
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

interface Input {
  findings?: unknown;
  level?: unknown;
}

function err(toolUseId: string, msg: string): ToolResult {
  return { tool_use_id: toolUseId, content: msg, is_error: true };
}

export const ReportFindings: ToolHandler = {
  schema: {
    name: ReportFindingsSchema.name,
    description: ReportFindingsSchema.description,
    inputSchema: ReportFindingsSchema.inputSchema,
  },
  isConcurrencySafe: true,
  async run(call: ToolCall, _ctx: RequestContext): Promise<ToolResult> {
    const args = (call.input ?? {}) as Input;
    const findings = args.findings;
    if (findings === undefined) {
      return err(call.id, "Invalid input: 'findings' is required.");
    }
    if (!Array.isArray(findings)) {
      return err(call.id, "Invalid input: 'findings' must be an array.");
    }

    let content = "";
    if (findings.length === 0) {
      content = "No findings reported.";
    } else if (findings.length === 1) {
      content = "1 finding reported.";
    } else {
      content = `${findings.length} findings reported.`;
    }

    return {
      tool_use_id: call.id,
      content,
    };
  },
};
