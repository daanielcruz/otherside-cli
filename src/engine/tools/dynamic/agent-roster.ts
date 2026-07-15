import { list as listSubagents } from "@/engine/agents/registry.ts";
import type { AgentRow } from "@/engine/tools/dynamic/Agent.ts";

type SubagentDef = ReturnType<typeof listSubagents>[number];

function agentToolsLabel(def: SubagentDef): string {
  const disallow = def.disallowedTools ?? [];
  if (def.tools?.kind === "wildcard") {
    return disallow.length > 0 ? `All tools except ${disallow.join(", ")}` : "*";
  }
  if (def.tools?.kind === "list") {
    const allow = def.tools.tools.filter((t) => !disallow.includes(t));
    return allow.length > 0 ? allow.join(", ") : "(none)";
  }
  if (disallow.length > 0) return `All tools except ${disallow.join(", ")}`;
  return "*";
}

export function agentRowsFromRegistry(): AgentRow[] {
  const defs = listSubagents();
  if (defs.length === 0) return [];
  return defs.map((def) => ({
    agentType: def.id,
    whenToUse: def.description,
    ...(def.whenToUseLean !== undefined ? { whenToUseLean: def.whenToUseLean } : {}),
    toolsLabel: agentToolsLabel(def),
  }));
}
