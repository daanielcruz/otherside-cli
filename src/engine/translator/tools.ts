import { isWorkflowEnabled } from "@/engine/background/workflows/runtime/gate.ts";
import { adapterExcludedBaseTools } from "@/engine/contract/prompt-adapter.ts";
import { isLeanPromptForModel } from "@/engine/providers/_shared/prompt-tier.ts";
import { getEditToolDescription } from "@/engine/tools/builtins/edit/edit.ts";
import { getReadToolDescription } from "@/engine/tools/builtins/read/read.ts";
import { getSkillToolDescription } from "@/engine/tools/builtins/skill.ts";
import type { ToolSchema } from "@/engine/tools/contract.ts";
import { activeDeferredToolNames, declaredSchemasForOverrides } from "@/engine/tools/deferred.ts";
import {
  buildAgentDescription,
  buildAgentInputSchema,
  buildTierAwareAgentDescription,
} from "@/engine/tools/dynamic/Agent.ts";
import { getAskUserQuestionToolDescription } from "@/engine/tools/dynamic/AskUserQuestion.ts";
import { AGENT_MULTIPROVIDER_ONLY_FIELDS } from "@/engine/tools/dynamic/agent-options.ts";
import { getBashPrompt } from "@/engine/tools/dynamic/Bash.ts";
import { getWebFetchDescription } from "@/engine/tools/dynamic/WebFetch.ts";
import { buildWorkflowDescription } from "@/engine/tools/dynamic/Workflow.ts";
import { getWriteToolDescription } from "@/engine/tools/dynamic/Write.ts";
import * as toolsRegistry from "@/engine/tools/registry.ts";
import type { ProviderToolDeclaration, TurnProvider } from "@/engine/translator/types.ts";
import {
  DEFAULT_CONFIG,
  isMultiproviderOrchestrationEnabled,
  type UserConfig,
} from "@/kernel/config/config.ts";
import { isMcpToolName } from "@/kernel/mcp/index.ts";
import { hasWholeToolDenyRule } from "@/kernel/permissions/index.ts";
import type { PermissionRule } from "@/kernel/permissions/types.ts";
import { hasCodexCredentialSync } from "@/kernel/storage/credentials.ts";

export interface ProviderToolDescriptionOptions {
  providerId: TurnProvider["id"];
  model?: string;
  mainAgent?: boolean;
  multiprovider?: boolean;
}

export function providerToolDescription(
  schema: Pick<ToolSchema, "name" | "description">,
  opts: ProviderToolDescriptionOptions,
): string {
  const lean = isLeanPromptForModel(opts.providerId, opts.model);
  const mainAgent = opts.mainAgent ?? true;
  switch (schema.name) {
    case "Agent":
      return opts.multiprovider === true
        ? buildTierAwareAgentDescription(opts.providerId, mainAgent)
        : buildAgentDescription({ lean, mainAgent });
    case "Workflow":
      return buildWorkflowDescription(opts.providerId, opts.multiprovider === true);
    case "Read":
      return getReadToolDescription({ lean });
    case "Edit":
      return getEditToolDescription({ lean });
    case "AskUserQuestion":
      return getAskUserQuestionToolDescription({ lean });
    case "Skill":
      return getSkillToolDescription({ lean });
    case "Bash":
      return getBashPrompt({ lean });
    case "Write":
      return getWriteToolDescription({ lean });
    case "WebFetch":
      return getWebFetchDescription({ lean });
    default:
      return schema.description;
  }
}

export function providerToolDeclarations(
  provider: TurnProvider,
  config?: UserConfig,
  opts: { model?: string; mainAgent?: boolean; permissionRules?: readonly PermissionRule[] } = {},
): ProviderToolDeclaration[] {
  const multiprovider = isMultiproviderOrchestrationEnabled(config);
  const descriptionOpts: ProviderToolDescriptionOptions = {
    providerId: provider.id,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    mainAgent: opts.mainAgent ?? true,
    multiprovider,
  };
  const excludedBase = adapterExcludedBaseTools(provider.promptAdapter());
  const generateImageActive = shouldExposeGenerateImage(provider, config);
  const workflowActive = isWorkflowEnabled(config ?? DEFAULT_CONFIG);
  const schemas = [
    ...declaredSchemasForOverrides(
      { ...provider.deferredOverrides(), alwaysDeclare: [] },
      implementedToolNames(),
    ),
    ...declaredMcpSchemas(opts.permissionRules ?? []),
  ]
    .filter((schema) => !excludedBase.has(schema.name))
    .filter((schema) => schema.name !== "GenerateImage" || generateImageActive)
    .filter((schema) => schema.name !== "Workflow" || workflowActive);
  if (provider.id === "anthropic") insertDeferredToolPlaceholder(schemas);

  return schemas.map((schema) => {
    const description = providerToolDescription(schema, descriptionOpts);
    if (schema.name === "Agent") {
      let agentSchema = buildAgentInputSchema(provider.id);
      if (!multiprovider)
        agentSchema = withoutAgentFields(agentSchema, AGENT_MULTIPROVIDER_ONLY_FIELDS);
      return toProviderTool({ ...schema, description, inputSchema: agentSchema });
    }
    const declaration = toProviderTool({ ...schema, description });
    if (schema.name === "Bash" && provider.id === "anthropic") {
      declaration.eager_input_streaming = true;
    }
    return declaration;
  });
}

const DEFERRED_TOOL_PLACEHOLDER: ToolSchema & { defer_loading: true } = {
  name: "DeferredToolPlaceholder",
  description:
    "Reserved placeholder that keeps deferred tool loading active; never call this tool.",
  inputSchema: { type: "object", properties: {} },
  defer_loading: true,
};

function insertDeferredToolPlaceholder(
  schemas: Array<ToolSchema | (ToolSchema & { defer_loading: true })>,
): void {
  const writeIndex = schemas.findIndex((schema) => schema.name === "Write");
  schemas.splice(writeIndex < 0 ? schemas.length : writeIndex, 0, DEFERRED_TOOL_PLACEHOLDER);
}

function withoutAgentFields(
  inputSchema: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const props = { ...((inputSchema.properties ?? {}) as Record<string, unknown>) };
  for (const field of fields) delete props[field];
  return { ...inputSchema, properties: props };
}

function shouldExposeGenerateImage(
  provider: TurnProvider,
  config: UserConfig | undefined,
): boolean {
  if (provider.id === "codex") return hasCodexCredentialSync();
  if (config?.imageGen !== true) return false;
  return hasCodexCredentialSync();
}

function implementedToolNames(): Set<string> {
  return new Set(toolsRegistry.list().map((handler) => handler.schema.name));
}

function declaredMcpSchemas(permissionRules: readonly PermissionRule[]): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}[] {
  const active = new Set(activeDeferredToolNames());
  return toolsRegistry
    .list()
    .map((handler) => handler.schema)
    .filter(
      (schema) =>
        isMcpToolName(schema.name) &&
        active.has(schema.name) &&
        !hasWholeToolDenyRule(permissionRules, schema.name),
    );
}

function toProviderTool(schema: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  defer_loading?: boolean;
}): ProviderToolDeclaration {
  const raw = schema.inputSchema;
  const inputSchema =
    typeof raw.type === "string" ? raw : { type: "object", properties: {}, ...raw };
  return {
    name: schema.name,
    description: schema.description,
    input_schema: inputSchema,
    ...(schema.defer_loading === true ? { defer_loading: true } : {}),
  };
}
