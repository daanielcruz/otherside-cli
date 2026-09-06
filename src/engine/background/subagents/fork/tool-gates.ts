import { MAX_AGENT_SPAWN_DEPTH } from "@/engine/agents/agent-context.ts";
import { activeDeferredToolNames } from "@/engine/tools/deferred.ts";
import { isForkDisallowedTool } from "@/engine/tools/fork-disallowed.ts";
import type { ToolCall } from "@/kernel/std/types/message.ts";
import { agentSpawnDepthFromContext } from "./spawn-depth.ts";
import type { ForkSpec } from "./types.ts";

// Skill spawns a nested skill fork, so it shares Agent's depth ceiling.
export const SPAWNABLE_NESTED_TOOLS = new Set(["Agent", "Skill"]);

export function toolInputObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

// Dispatch gate: a tool outside the allow set is dispatchable only when THIS
// agent loaded it through its own ToolSearch call — announcements from the
// main session (or any other agent) never grant dispatch here.
export function isDispatchableForkTool(
  name: string,
  allowSet: Set<string> | null,
  opts: {
    permissionMode?: "default" | "accept-edits" | "plan" | "yolo";
    ownerScope: string | undefined;
  },
): boolean {
  if (isForkDisallowedTool(name, opts.permissionMode)) return false;
  if (allowSet === null || allowSet.has(name)) return true;
  return allowSet.has("ToolSearch") && activeDeferredToolNames(opts.ownerScope).includes(name);
}

export function isAllowedInForkDeclarations(
  name: string,
  allowSet: Set<string> | null,
  spec: ForkSpec,
  ownerScope?: string,
): boolean {
  if (isForkDisallowedTool(name, spec.permissionMode)) return false;
  if (name === "Agent" && !spec.allowNestedAgents) return false;
  if (SPAWNABLE_NESTED_TOOLS.has(name)) {
    return (
      agentSpawnDepthFromContext() < MAX_AGENT_SPAWN_DEPTH &&
      (allowSet === null || allowSet.has(name))
    );
  }
  return (
    allowSet === null ||
    allowSet.has(name) ||
    (spec.deferredAllow?.has(name) ? activeDeferredToolNames(ownerScope).includes(name) : false)
  );
}

export function deniedNestedAgentType(
  call: ToolCall,
  allowedAgentTypes: string[] | undefined,
): string | null {
  if (call.name !== "Agent" || allowedAgentTypes === undefined) return null;
  const input = toolInputObject(call.input);
  const raw = input.subagent_type;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const requested = raw.trim();
  if (allowedAgentTypes.includes(requested)) return null;
  return `agent ${requested} not allowed for nested Agent call; allowed: ${allowedAgentTypes.join(", ")}`;
}
