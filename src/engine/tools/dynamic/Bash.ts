import { getSandboxSettings } from "@/engine/sandbox/manager.ts";
import {
  defaultShellTimeoutMs,
  getMaxBashTimeoutMs,
} from "@/engine/tools/_infra/command-analysis/timeouts.ts";
import type { ToolSchema } from "@/engine/tools/contract.ts";
import { buildBashDescription } from "@/harness/tools/Bash/description.ts";
import tool from "@/harness/tools/Bash/tool.json" with { type: "json" };

const DEFAULT_TIMEOUT_MS = defaultShellTimeoutMs();
const MAX_TIMEOUT_MS = getMaxBashTimeoutMs();
const MS_PER_MINUTE = 60_000;

const TOKENS: Record<string, string> = {
  "{{DEFAULT_TIMEOUT_MS}}": String(DEFAULT_TIMEOUT_MS),
  "{{MAX_TIMEOUT_MS}}": String(MAX_TIMEOUT_MS),
  "{{DEFAULT_TIMEOUT_MIN}}": String(DEFAULT_TIMEOUT_MS / MS_PER_MINUTE),
  "{{MAX_TIMEOUT_MIN}}": String(MAX_TIMEOUT_MS / MS_PER_MINUTE),
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

const inputSchema = patchSchemaTokens(tool.inputSchema);

function includeGitInstructions(): boolean {
  return process.env.OTHERSIDE_DISABLE_GIT_INSTRUCTIONS !== "1";
}

export function getBashPrompt(opts: { lean?: boolean } = {}): string {
  return buildBashDescription({
    ...(opts.lean !== undefined ? { lean: opts.lean } : {}),
    sandbox: getSandboxSettings(),
    includeGit: includeGitInstructions(),
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: MAX_TIMEOUT_MS,
  });
}

export function getBashSchema(): ToolSchema {
  return { ...BashSchema, description: getBashPrompt() };
}

export const BashSchema = {
  name: tool.name,
  description: "",
  inputSchema,
} satisfies ToolSchema;
