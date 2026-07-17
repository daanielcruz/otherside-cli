import * as toolRegistry from "@/engine/tools/registry.ts";
import { isMcpToolName } from "@/kernel/mcp/index.ts";
import { MAX_AGENT_SPAWN_DEPTH } from "./agent-context.ts";

export type AgentKind = "main" | "subagent" | "workflow" | "headless" | "bypass-latch";

// Parity 2.1.211: tools no agent may carry, external-build shape (reference
// constants module, disallowed-set generator on "external"). Reference
// members we do not ship (ConnectGitHub, RefreshMcpTools, EndConversation)
// are omitted.
export const ALL_AGENT_DISALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "EnterPlanMode",
  "ExitPlanMode",
  "AskUserQuestion",
  "ScheduleWakeup",
  "TaskOutput",
  "WaitForMcpServers",
  "Workflow",
]);

export const CUSTOM_AGENT_DISALLOWED_TOOLS: ReadonlySet<string> = new Set(["Workflow"]);

// Parity 2.1.211 async allowlist: from the task family only TaskStop rides
// along — planning Task tools stay out of async agents. The reference's
// teammate widening and its experimental Task-tool strip are both behind
// default-off flags and are not ported. Reference members we do not ship
// (PowerShell, REPL, Monitor, Artifact) are omitted; MultiEdit/LS are local
// adaptations of shipped surfaces. Agent is NOT allowlisted: it rides the
// spawn-depth rule, which the reference applies to every non-main kind.
export const ASYNC_AGENT_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "Bash",
  "Read",
  "Edit",
  "Write",
  "MultiEdit",
  "Glob",
  "Grep",
  "LS",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "TaskStop",
  "StructuredOutput",
  "ToolSearch",
  "Skill",
  "SendMessage",
  "EnterWorktree",
  "ExitWorktree",
]);

// Parity: the workflow subagent definition additionally disallows the Agent
// tool on top of the shared (non-async) filter.
const WORKFLOW_DISALLOWED_EXTRAS: ReadonlySet<string> = new Set(["Agent"]);

export interface ToolsetCtx {
  isBuiltIn: (toolName: string) => boolean;
  // Whether the AGENT DEFINITION is built-in (shipped), not the tool: custom
  // (user/project) agents lose CUSTOM_AGENT_DISALLOWED_TOOLS.
  isBuiltInAgent?: boolean;
  spawnDepth: number;
  permissionMode?: "default" | "accept-edits" | "plan" | "yolo";
  mcpToolNames?: readonly string[];
  skillToolNames?: readonly string[];
  customDisallow?: readonly string[];
}

export function resolveToolsetFor(kind: AgentKind, ctx: ToolsetCtx): readonly string[] {
  const pool = assembleToolPool(ctx);
  if (kind === "main") return pool;
  // Parity 2.1.211: workflow workers run the reference's synchronous-agent
  // filter (full pool minus the all-agent disallow set), so the planning Task
  // tools flow to them naturally; only async agents get the allowlist cut.
  const filtered = filterToolsForAgent(pool, {
    isAsync: kind !== "workflow",
    isBuiltInAgent: ctx.isBuiltInAgent ?? true,
    spawnDepth: ctx.spawnDepth,
    kind,
    ...(ctx.permissionMode !== undefined ? { permissionMode: ctx.permissionMode } : {}),
  });
  if (kind === "workflow") {
    return filtered.filter((name) => !WORKFLOW_DISALLOWED_EXTRAS.has(name));
  }
  return filtered;
}

export function assembleToolPool(ctx: ToolsetCtx): readonly string[] {
  const builtIns = toolRegistry
    .list()
    .map((h) => h.schema.name)
    .filter((name) => ctx.isBuiltIn(name))
    .sort((a, b) => a.localeCompare(b));
  const mcp = [...(ctx.mcpToolNames ?? [])].sort((a, b) => a.localeCompare(b));
  const skills = [...(ctx.skillToolNames ?? [])].sort((a, b) => a.localeCompare(b));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of [builtIns, mcp, skills]) {
    for (const name of list) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  if (ctx.customDisallow && ctx.customDisallow.length > 0) {
    const drop = new Set(ctx.customDisallow);
    return out.filter((t) => !drop.has(t));
  }
  return out;
}

interface FilterArgs {
  isAsync: boolean;
  isBuiltInAgent: boolean;
  spawnDepth: number;
  kind: AgentKind;
  permissionMode?: "default" | "accept-edits" | "plan" | "yolo";
}

export function filterToolsForAgent(tools: readonly string[], args: FilterArgs): readonly string[] {
  const out: string[] = [];
  for (const name of tools) {
    if (isMcpToolName(name)) {
      out.push(name);
      continue;
    }
    // Plan-mode agents must be able to hand their plan back for approval.
    if (name === "ExitPlanMode" && args.permissionMode === "plan") {
      out.push(name);
      continue;
    }
    if (ALL_AGENT_DISALLOWED_TOOLS.has(name)) continue;
    if (!args.isBuiltInAgent && CUSTOM_AGENT_DISALLOWED_TOOLS.has(name)) continue;
    // Parity: the spawn-depth rule owns the Agent tool for every non-main
    // kind — below the ceiling it stays, at the ceiling it drops, async or not.
    if (name === "Agent") {
      if (args.spawnDepth < MAX_AGENT_SPAWN_DEPTH) out.push(name);
      continue;
    }
    if (args.isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(name)) continue;
    out.push(name);
  }
  // A plan-mode agent always carries ExitPlanMode, even when the incoming
  // pool never offered it — it must be able to hand its plan back.
  if (args.permissionMode === "plan" && !out.includes("ExitPlanMode")) {
    out.push("ExitPlanMode");
  }
  return out;
}
