import { getSandboxSettings } from "@/engine/sandbox/manager.ts";
import {
  backgroundDeadlineApplies,
  defaultBackgroundTimeoutMs,
  defaultShellTimeoutMs,
  getMaxBackgroundTimeoutMs,
  getMaxBashTimeoutMs,
} from "@/engine/tools/_infra/command-analysis/timeouts.ts";
import type { ToolSchema } from "@/engine/tools/contract.ts";
import { applyTokens } from "@/harness/composer/tokens.ts";
import {
  type BashTimeoutLimits,
  bashTimeoutTokens,
  buildBashDescription,
} from "@/harness/tools/Bash/description.ts";
import tool from "@/harness/tools/Bash/tool.json" with { type: "json" };
import type { PermissionMode } from "@/kernel/std/types/permission-mode.ts";

const TIMEOUT_NUMBERS = {
  defaultTimeoutMs: defaultShellTimeoutMs(),
  maxTimeoutMs: getMaxBashTimeoutMs(),
  defaultBackgroundTimeoutMs: defaultBackgroundTimeoutMs(),
  maxBackgroundTimeoutMs: getMaxBackgroundTimeoutMs(),
};

// Whether background shells run under a time limit is known only once the
// session's runtime is set, so the texts read it when they are built.
function timeoutLimits(): BashTimeoutLimits {
  return { ...TIMEOUT_NUMBERS, backgroundDeadline: backgroundDeadlineApplies() };
}

function patchSchemaTokens<T>(node: T, tokens: Record<string, string>): T {
  if (typeof node === "string") return applyTokens(node, tokens) as unknown as T;
  if (Array.isArray(node))
    return node.map((item) => patchSchemaTokens(item, tokens)) as unknown as T;
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] = patchSchemaTokens(value, tokens);
    }
    return out as unknown as T;
  }
  return node;
}

// One schema per answer, so a session keeps the same object across turns.
const inputSchemaByDeadline = new Map<boolean, Record<string, unknown>>();

function resolvedInputSchema(): Record<string, unknown> {
  const limits = timeoutLimits();
  let schema = inputSchemaByDeadline.get(limits.backgroundDeadline);
  if (schema === undefined) {
    schema = patchSchemaTokens(tool.inputSchema, bashTimeoutTokens(limits, "parameter"));
    inputSchemaByDeadline.set(limits.backgroundDeadline, schema);
  }
  return schema;
}

function includeGitInstructions(): boolean {
  return process.env.OTHERSIDE_DISABLE_GIT_INSTRUCTIONS !== "1";
}

// A session that opens without permission prompts drops the lean steer toward the
// dedicated file tools. The first answer holds for the session, so a later mode
// switch never reshapes the cached tool prefix.
const dedicatedToolSteerBySession = new Map<string, boolean>();

export function leanDedicatedToolSteer(sessionId: string, permissionMode: PermissionMode): boolean {
  let steer = dedicatedToolSteerBySession.get(sessionId);
  if (steer === undefined) {
    steer = permissionMode !== "yolo";
    dedicatedToolSteerBySession.set(sessionId, steer);
  }
  return steer;
}

export function forgetDedicatedToolSteer(sessionId: string): void {
  dedicatedToolSteerBySession.delete(sessionId);
}

export function getBashPrompt(opts: { lean?: boolean; dedicatedToolSteer?: boolean } = {}): string {
  return buildBashDescription({
    ...(opts.lean !== undefined ? { lean: opts.lean } : {}),
    ...(opts.dedicatedToolSteer !== undefined
      ? { dedicatedToolSteer: opts.dedicatedToolSteer }
      : {}),
    sandbox: getSandboxSettings(),
    includeGit: includeGitInstructions(),
    ...timeoutLimits(),
  });
}

export function getBashSchema(): ToolSchema {
  return { ...BashSchema, description: getBashPrompt() };
}

export const BashSchema: ToolSchema = {
  name: tool.name,
  description: "",
  get inputSchema() {
    return resolvedInputSchema();
  },
};
