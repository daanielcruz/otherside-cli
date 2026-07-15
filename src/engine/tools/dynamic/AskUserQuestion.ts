import type { ToolSchema } from "@/engine/tools/contract.ts";
import tool from "@/harness/tools/AskUserQuestion/tool.json" with { type: "json" };

export const ASK_USER_QUESTION_TOOL_CHIP_WIDTH = 12;

export function getAskUserQuestionToolDescription(opts: { lean?: boolean } = {}): string {
  return opts.lean ? tool.description.lean : tool.description.full;
}

const TOKENS: Record<string, string> = {
  "{{ASK_USER_QUESTION_TOOL_CHIP_WIDTH}}": String(ASK_USER_QUESTION_TOOL_CHIP_WIDTH),
};

function interpolate(source: string): string {
  let out = source;
  for (const [token, value] of Object.entries(TOKENS)) {
    out = out.split(token).join(value);
  }
  return out;
}

function patchSchemaTokens<T>(node: T): T {
  if (typeof node === "string") return interpolate(node) as unknown as T;
  if (Array.isArray(node)) return node.map(patchSchemaTokens) as unknown as T;
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] = patchSchemaTokens(value);
    }
    return out as unknown as T;
  }
  return node;
}

const inputSchema = patchSchemaTokens(tool.inputSchema);

export const AskUserQuestionSchema = {
  name: tool.name,
  description: getAskUserQuestionToolDescription({ lean: true }),
  inputSchema,
} satisfies ToolSchema;
