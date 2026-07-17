import type { McpServerSpec } from "@/kernel/mcp/index.ts";
import type { PermissionMode } from "@/kernel/std/types/permission-mode.ts";
import type { ParsedHooks, ToolsField } from "./frontmatter.ts";

export type SubagentScope = "builtin" | "user" | "project";

export interface SubagentDef {
  id: string;
  name: string;
  description: string;
  whenToUseLean?: string;
  body: string;
  tools: ToolsField | null;
  disallowedTools: string[] | null;
  model: Record<string, { model: string; effort?: string }>;
  background: boolean;
  scope: SubagentScope;
  sourcePath?: string;
  mcpServers?: McpServerSpec[] | null;
  skills?: string[] | null;
  hooks?: ParsedHooks | null;
  maxTurns?: number;
  // Overrides the parent's permission mode for this agent's run — unless the
  // parent runs in yolo or accept-edits, which always win.
  permissionMode?: PermissionMode;
}

export function mcpServerSpecName(spec: McpServerSpec): string {
  return typeof spec === "string" ? spec : (Object.keys(spec)[0] ?? "");
}

const registry = new Map<string, SubagentDef>();

export type AgentRegistrySnapshot = readonly SubagentDef[];

export function register(def: SubagentDef): void {
  registry.set(def.id, def);
}

function normalizeAgentKey(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, "");
}

export function get(idOrName: string): SubagentDef | undefined {
  const direct = registry.get(idOrName);
  if (direct) return direct;
  const normalized = normalizeAgentKey(idOrName);
  for (const def of registry.values()) {
    if (normalizeAgentKey(def.id) === normalized || normalizeAgentKey(def.name) === normalized)
      return def;
  }
  return undefined;
}

export function list(): SubagentDef[] {
  return [...registry.values()]
    .filter((def) => def.id !== "fork")
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function snapshot(): AgentRegistrySnapshot {
  return [...registry.values()];
}

export function replaceSnapshot(next: AgentRegistrySnapshot): void {
  registry.clear();
  for (const def of next) registry.set(def.id, def);
}

export function clear(): void {
  registry.clear();
}
