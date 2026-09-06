import { MAX_AGENT_SPAWN_DEPTH } from "@/engine/agents/agent-context.ts";
import { mcpServerSpecName, type SubagentDef } from "@/engine/agents/registry.ts";
import {
  STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from "@/engine/background/subagents/structured-output.ts";
import * as providers from "@/engine/providers/registry.ts";
import type { ToolSchema } from "@/engine/tools/contract.ts";
import { activeDeferredToolNames, declaredSchemasForOverrides } from "@/engine/tools/deferred.ts";
import { buildAgentInputSchema } from "@/engine/tools/dynamic/Agent.ts";
import * as toolRegistry from "@/engine/tools/registry.ts";
import type { ProviderToolDeclaration } from "@/engine/translator/index.ts";
import { getAssembledTurn } from "@/engine/translator/index.ts";
import {
  type ProviderToolDescriptionOptions,
  providerToolDescription,
} from "@/engine/translator/tools.ts";
import { isMcpToolName } from "@/kernel/mcp/index.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { agentSpawnDepthFromContext } from "./spawn-depth.ts";
import { isAllowedInForkDeclarations } from "./tool-gates.ts";
import type { ForkSpec } from "./types.ts";

type RegisteredSchema = ReturnType<typeof toolRegistry.list>[number]["schema"];

function forkToolDescription(
  name: string,
  description: string,
  opts: Omit<ProviderToolDescriptionOptions, "mainAgent">,
): string {
  return providerToolDescription({ name, description }, { ...opts, mainAgent: false });
}

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
  // An unmatched spec is not an error here: an inline server config is loaded
  // into the fork's own namespace at spawn, never into this global registry,
  // and a named server that failed to connect is reported by the spawn path.
  for (const server of def.mcpServers ?? []) {
    const prefix = `mcp__${mcpServerSpecName(server)}__`;
    for (const s of mcpSchemas.filter((s) => s.name.startsWith(prefix))) granted.set(s.name, s);
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

const NAMED_SUBAGENT_TOOL_ORDER = [
  "Agent",
  "Bash",
  "Edit",
  "Read",
  "ReportFindings",
  "Skill",
  "ToolSearch",
  "DeferredToolPlaceholder",
  "Write",
] as const;

const INHERITED_FORK_TOOL_ORDER = [
  "Agent",
  "AskUserQuestion",
  "Bash",
  "Edit",
  "Read",
  "ReportFindings",
  "Skill",
  "ToolSearch",
  "Workflow",
  "DeferredToolPlaceholder",
  "Write",
] as const;

const DEFERRED_TOOL_PLACEHOLDER: ProviderToolDeclaration = {
  name: "DeferredToolPlaceholder",
  description:
    "Reserved placeholder that keeps deferred tool loading active; never call this tool.",
  input_schema: { type: "object", properties: {} },
  defer_loading: true,
};

function inputSchemaForSubagent(schema: ToolSchema, ctx: RequestContext): Record<string, unknown> {
  if (schema.name === "Agent") {
    return buildAgentInputSchema(ctx.provider, ctx.orchestrationMode ?? "disabled");
  }
  return typeof schema.inputSchema.type === "string"
    ? schema.inputSchema
    : { type: "object", properties: {}, ...schema.inputSchema };
}

function toSubagentDeclaration(schema: ToolSchema, ctx: RequestContext): ProviderToolDeclaration {
  return {
    name: schema.name,
    description: forkToolDescription(schema.name, schema.description, {
      providerId: ctx.provider,
      model: ctx.model,
      orchestrationMode: ctx.orchestrationMode ?? "disabled",
    }),
    input_schema: inputSchemaForSubagent(schema, ctx),
  };
}

function isSkillToolName(name: string): boolean {
  return toolRegistry.getNamespace(name)?.startsWith("skill:") ?? false;
}

function atNestedSpawnCeiling(name: string): boolean {
  return (
    (name === "Agent" || name === "Skill") && agentSpawnDepthFromContext() >= MAX_AGENT_SPAWN_DEPTH
  );
}

export function withStructuredOutputDeclaration(
  declarations: ProviderToolDeclaration[],
  outputSchema: Record<string, unknown>,
): ProviderToolDeclaration[] {
  return [
    ...declarations.filter((declaration) => declaration.name !== STRUCTURED_OUTPUT_TOOL_NAME),
    {
      name: STRUCTURED_OUTPUT_TOOL_NAME,
      description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
      input_schema: outputSchema,
    },
  ];
}

export function buildSubagentBaseDeclarations(
  spec: ForkSpec,
  ctx: RequestContext,
): {
  parentTurn: ReturnType<typeof getAssembledTurn>;
  declarations: ProviderToolDeclaration[];
} {
  const provider = providers.get(ctx.provider);
  const parentTurn = spec.inheritParentTurn ? getAssembledTurn(ctx.sessionId) : undefined;
  if (parentTurn) {
    const retainedByName = new Map(
      parentTurn.tools.map((declaration) => [declaration.name, declaration]),
    );
    const declarations = INHERITED_FORK_TOOL_ORDER.flatMap((name) => {
      if (name === "DeferredToolPlaceholder" && provider.id !== "anthropic") return [];
      const declaration = retainedByName.get(name);
      return declaration === undefined || atNestedSpawnCeiling(name) ? [] : [declaration];
    });
    for (const declaration of parentTurn.tools) {
      if (
        (isMcpToolName(declaration.name) || isSkillToolName(declaration.name)) &&
        !declarations.some((existing) => existing.name === declaration.name)
      ) {
        declarations.push(declaration);
      }
    }
    const implemented = new Set(toolRegistry.list().map((handler) => handler.schema.name));
    // A parent-turn fork inherits the spawning session's transcript, so the
    // session's announced tools legitimately belong to its declared set; the
    // fork's own later ToolSearch loads land in its own scope and union in.
    const activeDeferred = new Set([
      ...activeDeferredToolNames(),
      ...activeDeferredToolNames(ctx.agentOwnerId),
    ]);
    const candidateSchemas = new Map(
      [
        ...declaredSchemasForOverrides(provider.deferredOverrides(), implemented),
        ...declaredSchemasForOverrides(provider.deferredOverrides(), implemented, ctx.agentOwnerId),
      ].map((schema) => [schema.name, schema]),
    );
    for (const schema of candidateSchemas.values()) {
      if (
        !activeDeferred.has(schema.name) ||
        !isAllowedInForkDeclarations(schema.name, spec.allowSet, spec, ctx.agentOwnerId) ||
        declarations.some((declaration) => declaration.name === schema.name)
      ) {
        continue;
      }
      declarations.push(retainedByName.get(schema.name) ?? toSubagentDeclaration(schema, ctx));
    }
    for (const handler of toolRegistry.list()) {
      const { schema } = handler;
      if (
        !isMcpToolName(schema.name) ||
        !activeDeferred.has(schema.name) ||
        !isAllowedInForkDeclarations(schema.name, spec.allowSet, spec, ctx.agentOwnerId) ||
        declarations.some((declaration) => declaration.name === schema.name)
      ) {
        continue;
      }
      declarations.push(retainedByName.get(schema.name) ?? toSubagentDeclaration(schema, ctx));
    }
    return { parentTurn, declarations };
  }

  const implemented = new Set(toolRegistry.list().map((handler) => handler.schema.name));
  // Fresh-context agents never saw the parent transcript: only their OWN
  // ToolSearch loads count toward declared deferred extras.
  const activeDeferred = new Set(activeDeferredToolNames(ctx.agentOwnerId));
  const schemasByName = new Map(
    declaredSchemasForOverrides(provider.deferredOverrides(), implemented, ctx.agentOwnerId).map(
      (schema) => [schema.name, schema],
    ),
  );
  const declarations: ProviderToolDeclaration[] = [];
  for (const name of NAMED_SUBAGENT_TOOL_ORDER) {
    if (name === "DeferredToolPlaceholder") {
      if (provider.id === "anthropic") declarations.push(DEFERRED_TOOL_PLACEHOLDER);
      continue;
    }
    const schema = schemasByName.get(name);
    if (
      schema === undefined ||
      !isAllowedInForkDeclarations(name, spec.allowSet, spec, ctx.agentOwnerId)
    ) {
      continue;
    }
    declarations.push({
      name,
      description: forkToolDescription(name, schema.description, {
        providerId: provider.id,
        model: ctx.model,
        orchestrationMode: ctx.orchestrationMode ?? "disabled",
      }),
      input_schema: inputSchemaForSubagent(schema, ctx),
    });
  }

  for (const handler of toolRegistry.list()) {
    const { schema } = handler;
    if (
      !isSkillToolName(schema.name) ||
      !isAllowedInForkDeclarations(schema.name, spec.allowSet, spec, ctx.agentOwnerId) ||
      declarations.some((declaration) => declaration.name === schema.name)
    ) {
      continue;
    }
    declarations.push({
      name: schema.name,
      description: forkToolDescription(schema.name, schema.description, {
        providerId: provider.id,
        model: ctx.model,
        orchestrationMode: ctx.orchestrationMode ?? "disabled",
      }),
      input_schema:
        typeof schema.inputSchema.type === "string"
          ? schema.inputSchema
          : { type: "object", properties: {}, ...schema.inputSchema },
    });
  }
  for (const schema of declaredSchemasForOverrides(
    provider.deferredOverrides(),
    implemented,
    ctx.agentOwnerId,
  )) {
    if (
      !activeDeferred.has(schema.name) ||
      !isAllowedInForkDeclarations(schema.name, spec.allowSet, spec, ctx.agentOwnerId) ||
      declarations.some((declaration) => declaration.name === schema.name)
    ) {
      continue;
    }
    declarations.push(toSubagentDeclaration(schema, ctx));
  }
  for (const handler of toolRegistry.list()) {
    const { schema } = handler;
    if (
      !isMcpToolName(schema.name) ||
      !activeDeferred.has(schema.name) ||
      !isAllowedInForkDeclarations(schema.name, spec.allowSet, spec, ctx.agentOwnerId) ||
      declarations.some((declaration) => declaration.name === schema.name)
    ) {
      continue;
    }
    declarations.push(toSubagentDeclaration(schema, ctx));
  }
  for (const declaration of spec.extraDeclarations ?? []) {
    if (!declarations.some((existing) => existing.name === declaration.name)) {
      declarations.push(declaration);
    }
  }
  return { parentTurn, declarations };
}
