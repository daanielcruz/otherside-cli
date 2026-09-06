import { get as getAgent, type SubagentDef } from "@/engine/agents/registry.ts";
import { type AgentKind, resolveToolsetFor } from "@/engine/agents/toolset.ts";
import {
  announcedMcpDeclarations,
  mcpDeclarationsForDef,
} from "@/engine/background/subagents/fork/declarations.ts";
import { agentSpawnDepth } from "@/engine/background/subagents/fork/spawn-depth.ts";
import * as toolRegistry from "@/engine/tools/registry.ts";
import type { ProviderToolDeclaration } from "@/engine/translator/index.ts";
import { isMcpToolName } from "@/kernel/mcp/index.ts";
import { parseRuleValueText } from "@/kernel/permissions/types.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const WORKFLOW_RETURN_CONTRACT =
  "Your final assistant text IS the return value consumed by a deterministic script, not a human-facing message. Return raw data only.";
const WORKFLOW_AGENT_BODY = `You are a workflow subagent. ${WORKFLOW_RETURN_CONTRACT}`;

export type WorkflowAgentProfile =
  | {
      ok: true;
      body: string;
      allowSet: Set<string> | null;
      extraDeclarations: ProviderToolDeclaration[];
    }
  | { ok: false; error: string };

export function resolveWorkflowAgentProfile(
  agentType: string | undefined,
  ctx?: RequestContext,
): WorkflowAgentProfile {
  if (agentType === undefined) {
    return {
      ok: true,
      body: WORKFLOW_AGENT_BODY,
      allowSet: resolveDefaultAllowSetForFork("workflow", ctx ?? WORKFLOW_DEFAULT_CTX),
      extraDeclarations: announcedMcpDeclarations(),
    };
  }
  const def = getAgent(agentType);
  if (!def) return { ok: false, error: `unknown agentType: ${agentType}` };
  const allowSet = ctx
    ? resolveAllowSetForFork(def, "workflow", ctx)
    : resolveAllowSetForFork(def, "workflow", WORKFLOW_DEFAULT_CTX);
  const extraDeclarations = mcpDeclarationsForDef(def, allowSet);
  const base = def.body.trim().length > 0 ? def.body : `You are the ${def.name} subagent.`;
  return {
    ok: true,
    body: `${base}\n\n${WORKFLOW_RETURN_CONTRACT}`,
    allowSet,
    extraDeclarations,
  };
}

const WORKFLOW_DEFAULT_CTX = {
  agentOwnerId: undefined,
} as unknown as RequestContext;

function isSkillToolName(name: string): boolean {
  return toolRegistry.getNamespace(name)?.startsWith("skill:") ?? false;
}

export function resolveDefaultAllowSetForFork(kind: AgentKind, ctx: RequestContext): Set<string> {
  const registryNames = toolRegistry.list().map((handler) => handler.schema.name);
  return new Set(
    resolveToolsetFor(kind, {
      isBuiltIn: (name) => !isMcpToolName(name) && !isSkillToolName(name),
      isBuiltInAgent: true,
      spawnDepth: agentSpawnDepth(ctx),
      mcpToolNames: registryNames.filter(isMcpToolName),
      skillToolNames: registryNames.filter(isSkillToolName),
    }),
  );
}

export function resolveAllowSetForFork(
  def: SubagentDef,
  kind: AgentKind,
  ctx: RequestContext,
): Set<string> {
  const registryNames = toolRegistry.list().map((handler) => handler.schema.name);
  const pool = resolveToolsetFor(kind, {
    isBuiltIn: (name) => !isMcpToolName(name) && !isSkillToolName(name),
    isBuiltInAgent: def.scope === "builtin",
    spawnDepth: agentSpawnDepth(ctx),
    // The roster is keyed on the DEFINITION's mode, never the parent's: a
    // plan-pinned agent carries ExitPlanMode regardless of who spawned it.
    ...(def.permissionMode !== undefined ? { permissionMode: def.permissionMode } : {}),
    mcpToolNames: registryNames.filter(isMcpToolName),
    skillToolNames: registryNames.filter(isSkillToolName),
  });
  const allow = new Set(pool);
  if (def.tools?.kind === "list") {
    const explicit = new Set(def.tools.tools.map(baseToolName));
    for (const name of [...allow]) {
      if (!explicit.has(name)) allow.delete(name);
    }
    for (const name of explicit) {
      if (isMcpToolName(name)) allow.add(name);
    }
  }
  const disallow = new Set((def.disallowedTools ?? []).map(baseToolName));
  for (const name of disallow) allow.delete(name);
  return allow;
}

function baseToolName(name: string): string {
  return parseRuleValueText(name)?.toolName ?? name;
}

export function computeAllowedAgentTypes(def: ReturnType<typeof getAgent>): string[] | undefined {
  if (!def?.tools || def.tools.kind !== "list") return undefined;
  const out: string[] = [];
  for (const tool of def.tools.tools) {
    const parsed = parseRuleValueText(tool);
    if (parsed?.toolName !== "Agent" || !parsed.ruleContent) continue;
    for (const part of parsed.ruleContent.split(",")) {
      const value = part.trim();
      if (value.length > 0) out.push(value);
    }
  }
  return out.length > 0 ? out : undefined;
}
