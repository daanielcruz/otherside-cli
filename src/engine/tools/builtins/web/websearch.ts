import { getProviderConfig } from "@/engine/contract/registry.ts";
import { invalid, parseInput } from "@/engine/tools/common.ts";
import type { ToolHandler } from "@/engine/tools/contract.ts";
import { searchDuckDuckGo } from "@/engine/tools/duckduckgo.ts";
import { WebSearchSchema } from "@/engine/tools/dynamic/WebSearch.ts";
import type { ToolCall, ToolResult } from "@/kernel/std/types/message.ts";

export const WebSearch: ToolHandler = {
  schema: {
    name: WebSearchSchema.name,
    description: WebSearchSchema.description,
    inputSchema: WebSearchSchema.inputSchema,
  },
  isConcurrencySafe: true,
  async run(call, ctx): Promise<ToolResult> {
    const input = parseInput(call as ToolCall);
    if (typeof input === "string") return invalid(call.id, input);
    try {
      const fn = getProviderConfig(ctx.provider)?.webSearch ?? searchDuckDuckGo;
      const payload = await fn(input, ctx);
      return { tool_use_id: call.id, content: JSON.stringify(payload) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return invalid(call.id, msg);
    }
  },
};
