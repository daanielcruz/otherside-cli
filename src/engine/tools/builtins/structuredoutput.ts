import type { ToolHandler } from "@/engine/tools/contract.ts";
import StructuredOutputSchema from "@/harness/tools/StructuredOutput/tool.json" with {
  type: "json",
};
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

function ok(toolUseId: string, payload: unknown): ToolResult {
  return { tool_use_id: toolUseId, content: JSON.stringify(payload) };
}

export const StructuredOutput: ToolHandler = {
  schema: {
    name: StructuredOutputSchema.name,
    description: StructuredOutputSchema.description,
    inputSchema: StructuredOutputSchema.inputSchema,
  },
  async run(call: ToolCall, _ctx: RequestContext): Promise<ToolResult> {
    return ok(call.id, {
      structured_output: call.input ?? {},
      message: "Structured output provided successfully",
    });
  },
};
