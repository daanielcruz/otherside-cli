import type { ToolSchema } from "@/engine/tools/contract.ts";
import tool from "@/harness/tools/WebFetch/tool.json" with { type: "json" };

export function getWebFetchDescription(opts: { lean?: boolean } = {}): string {
  if (opts.lean) return tool.description.lean;
  return tool.description.full;
}

export const WebFetchSchema = {
  name: tool.name,
  description: getWebFetchDescription(),
  inputSchema: tool.inputSchema,
} satisfies ToolSchema;
