import { DEFAULT_MAX_AGE_DAYS } from "@/engine/background/cron/index.ts";
import type { ToolSchema } from "@/engine/tools/contract.ts";
import tool from "@/harness/tools/CronCreate/tool.json" with { type: "json" };

const TOKENS: Record<string, string> = {
  "{{DEFAULT_MAX_AGE_DAYS}}": String(DEFAULT_MAX_AGE_DAYS),
};

function applyTokens(source: string): string {
  let out = source;
  for (const [token, value] of Object.entries(TOKENS)) {
    out = out.split(token).join(value);
  }
  return out;
}

function patchSchemaTokens<T>(node: T): T {
  if (typeof node === "string") return applyTokens(node) as unknown as T;
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

const description = applyTokens(tool.description);
const inputSchema = patchSchemaTokens(tool.inputSchema);

export const CronCreateSchema = {
  name: tool.name,
  description,
  inputSchema,
} satisfies ToolSchema;
