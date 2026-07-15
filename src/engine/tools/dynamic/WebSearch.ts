import type { ToolSchema } from "@/engine/tools/contract.ts";
import tool from "@/harness/tools/WebSearch/tool.json" with { type: "json" };

function localMonthYear(now: Date = new Date()): string {
  return now.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export function buildWebSearchDescription(now: Date = new Date()): string {
  return tool.description.replace("{{CURRENT_MONTH_YEAR}}", localMonthYear(now));
}

export const WebSearchSchema = {
  name: tool.name,
  description: buildWebSearchDescription(),
  inputSchema: tool.inputSchema,
} satisfies ToolSchema;
