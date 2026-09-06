import { isWorkflowEnabled } from "@/engine/background/workflows/runtime/gate.ts";
import { adapterExcludedBaseTools } from "@/engine/contract/prompt-adapter.ts";
import { isLeanPromptForModel } from "@/engine/providers/_shared/prompt-tier.ts";
import { resolveImageGeneratorProvider } from "@/engine/providers/image-generation.ts";
import { editToolDescription } from "@/engine/tools/builtins/edit/edit.ts";
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
import { getBashPrompt } from "@/engine/tools/dynamic/Bash.ts";
import { getWebFetchDescription } from "@/engine/tools/dynamic/WebFetch.ts";
import { buildWorkflowDescription } from "@/engine/tools/dynamic/Workflow.ts";
import { writeToolDescription } from "@/engine/tools/dynamic/Write.ts";
import * as toolsRegistry from "@/engine/tools/registry.ts";
import type { ProviderToolDeclaration, TurnProvider } from "@/engine/translator/types.ts";
import {
  DEFAULT_CONFIG,
  effectiveOrchestrationMode,
  type UserConfig,
} from "@/kernel/config/config.ts";
import { isMcpToolName } from "@/kernel/mcp/index.ts";
import { hasWholeToolDenyRule } from "@/kernel/permissions/index.ts";
import type { PermissionRule } from "@/kernel/permissions/types.ts";
import type { OrchestrationMode } from "@/kernel/std/types/orchestration-mode.ts";
import { hasCredentialSync } from "@/kernel/storage/credentials.ts";

export interface ProviderToolDescriptionOptions {
  providerId: TurnProvider["id"];
  model?: string;
  mainAgent?: boolean;
  orchestrationMode?: OrchestrationMode;
  workflowSizeGuideline?: UserConfig["workflowSizeGuideline"];
}

export function providerToolDescription(
  schema: Pick<ToolSchema, "name" | "description">,
  opts: ProviderToolDescriptionOptions,
): string {
  const lean = isLeanPromptForModel(opts.providerId, opts.model);
  const mainAgent = opts.mainAgent ?? true;
  switch (schema.name) {
    case "Agent":
      return opts.orchestrationMode === "feudalism"
        ? buildTierAwareAgentDescription(opts.providerId, mainAgent)
        : buildAgentDescription({ lean, mainAgent });
    case "Workflow":
      return buildWorkflowDescription(
        opts.providerId,
        opts.orchestrationMode ?? "disabled",
        opts.workflowSizeGuideline,
      );
    case "Read":
      return getReadToolDescription({ lean });
    case "Edit":
      return editToolDescription({ lean });
    case "AskUserQuestion":
      return getAskUserQuestionToolDescription({ lean });
    case "Skill":
      return getSkillToolDescription({ lean });
    case "Bash":
      return getBashPrompt({ lean });
    case "Write":
      return writeToolDescription({ lean });
    case "WebFetch":
      return getWebFetchDescription({ lean });
    default:
      return schema.description;
  }
}

export function providerToolDeclarations(
  provider: TurnProvider,
  config?: UserConfig,
  opts: {
    model?: string;
    mainAgent?: boolean;
    permissionRules?: readonly PermissionRule[];
    orchestrationMode?: OrchestrationMode;
  } = {},
): ProviderToolDeclaration[] {
  // The session's mode when the caller carries it; config only covers callers
  // outside a session context.
  const orchestrationMode = opts.orchestrationMode ?? effectiveOrchestrationMode(config);
  const descriptionOpts: ProviderToolDescriptionOptions = {
    providerId: provider.id,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    mainAgent: opts.mainAgent ?? true,
    orchestrationMode,
    workflowSizeGuideline: config?.workflowSizeGuideline,
  };
  const excludedBase = adapterExcludedBaseTools(provider.promptAdapter());
  const generateImageActive = shouldExposeGenerateImage(provider, config);
  const workflowActive = isWorkflowEnabled(config ?? DEFAULT_CONFIG);
  const schemas = [
    ...declaredSchemasForOverrides(
      {
        ...provider.deferredOverrides(),
        alwaysDeclare: generateImageActive ? ["GenerateImage"] : [],
      },
      implementedToolNames(),
    ),
    ...declaredMcpSchemas(opts.permissionRules ?? []),
  ]
    .filter((schema) => !excludedBase.has(schema.name))
    .filter((schema) => schema.name !== "GenerateImage" || generateImageActive)
    .filter((schema) => schema.name !== "Workflow" || workflowActive);
  if (provider.id === "anthropic") insertDeferredToolPlaceholder(schemas);
  const activeDeferred = new Set(activeDeferredToolNames());

  return schemas.map((schema) => {
    const description = providerToolDescription(schema, descriptionOpts);
    if (schema.name === "Agent") {
      const agentSchema = buildAgentInputSchema(provider.id, orchestrationMode);
      return toProviderTool({ ...schema, description, inputSchema: agentSchema });
    }
    return toProviderTool({
      ...schema,
      description,
      ...(provider.id === "anthropic" && activeDeferred.has(schema.name)
        ? { defer_loading: true as const }
        : {}),
    });
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

function shouldExposeGenerateImage(
  provider: TurnProvider,
  config: UserConfig | undefined,
): boolean {
  const generator = resolveImageGeneratorProvider(config?.imageGenProvider, provider.id);
  return generator !== null && hasCredentialSync(generator);
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
