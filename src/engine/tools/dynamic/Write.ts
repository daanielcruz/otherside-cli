import type { ToolSchema } from "@/engine/tools/contract.ts";
import tool from "@/harness/tools/Write/tool.json" with { type: "json" };

export function getWriteToolDescription(opts: { lean?: boolean } = {}): string {
  if (opts.lean) return tool.description.lean;
  return tool.description.full;
}

export const WriteSchema = {
  name: tool.name,
  description: getWriteToolDescription(),
  inputSchema: tool.inputSchema,
} satisfies ToolSchema;
