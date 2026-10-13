import { AsyncLocalStorage } from "node:async_hooks";
import type { PermissionDecision } from "@/engine/tools/pipeline.ts";
import type { ToolCall } from "@/kernel/std/types/message.ts";
import type { PermissionMode } from "@/kernel/std/types/permission-mode.ts";

export const MAX_AGENT_SPAWN_DEPTH = 5;

export type PermissionResolver = (call: ToolCall) => Promise<PermissionDecision>;

const permissionResolverStorage = new AsyncLocalStorage<PermissionResolver>();

export function getPermissionResolver(): PermissionResolver | undefined {
  return permissionResolverStorage.getStore();
}

export function runWithPermissionResolver<T>(resolver: PermissionResolver, fn: () => T): T {
  return permissionResolverStorage.run(resolver, fn);
}

export interface AgentContext {
  agentId: string;
  parentAgentId?: string;
  depth: number;
  parentSessionId: string;
  agentType: "subagent";
  subagentName: string;
  // Agent-definition permission mode, pinned at spawn. When set, permission
  // resolution uses this instead of the parent's live broker mode — the
  // parent's yolo/accept-edits still win (filtered at spawn, never stored).
  permissionModeOverride?: PermissionMode;
  // Background agents cannot surface interactive permission UI. Their asks
  // auto-deny after rules and automatic allowances have been evaluated.
  shouldAvoidPermissionPrompts?: boolean;
}

const storage = new AsyncLocalStorage<AgentContext>();

export function currentSpawnedAgentScope(): AgentContext | undefined {
  return storage.getStore();
}

export function withSpawnedAgentScope<T>(context: AgentContext, fn: () => T): T {
  return storage.run(context, fn);
}
