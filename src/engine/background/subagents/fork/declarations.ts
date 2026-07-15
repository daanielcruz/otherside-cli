import { mcpServerSpecName, type SubagentDef } from "@/engine/agents/registry.ts";
import { publish } from "@/engine/background/tasks/bus.ts";
import { activeDeferredToolNames } from "@/engine/tools/deferred.ts";
import * as toolRegistry from "@/engine/tools/registry.ts";
import type { ProviderToolDeclaration } from "@/engine/translator/index.ts";
import { isMcpToolName } from "@/kernel/mcp/index.ts";

type RegisteredSchema = ReturnType<typeof toolRegistry.list>[number]["schema"];

export function toMcpDeclaration(schema: RegisteredSchema): ProviderToolDeclaration {
  return {
    name: schema.name,
    description: schema.description,
    input_schema:
      typeof schema.inputSchema.type === "string"
        ? schema.inputSchema
        : { type: "object", properties: {}, ...schema.inputSchema },
  };
}

export function announcedMcpDeclarations(): ProviderToolDeclaration[] {
  const active = new Set(activeDeferredToolNames());
  return toolRegistry
    .list()
    .map((h) => h.schema)
    .filter((s) => isMcpToolName(s.name) && active.has(s.name))
    .map(toMcpDeclaration);
}

export function mcpDeclarationsForDef(
  def: SubagentDef,
  allowSet: Set<string> | null,
): ProviderToolDeclaration[] {
  const mcpSchemas = toolRegistry
    .list()
    .map((h) => h.schema)
    .filter((s) => isMcpToolName(s.name));
  const granted = new Map<string, (typeof mcpSchemas)[number]>();
  for (const server of def.mcpServers ?? []) {
    const serverName = mcpServerSpecName(server);
    const prefix = `mcp__${serverName}__`;
    const matched = mcpSchemas.filter((s) => s.name.startsWith(prefix));
    if (matched.length === 0) {
      publish("error", `Agent "${def.id}": MCP server "${serverName}" has no connected tools`);
      continue;
    }
    for (const s of matched) granted.set(s.name, s);
  }
  if (allowSet === null) {
    const active = new Set(activeDeferredToolNames());
    for (const s of mcpSchemas) {
      if (active.has(s.name)) granted.set(s.name, s);
    }
  } else {
    for (const name of granted.keys()) allowSet.add(name);
  }
  return [...granted.values()].map(toMcpDeclaration);
}
