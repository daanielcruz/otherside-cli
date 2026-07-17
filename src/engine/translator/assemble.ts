import { findModel, parseModelId } from "@/engine/model/catalog.ts";
import { knowledgeCutoffFor } from "@/engine/model/facts/knowledge-cutoff.ts";
import {
  isFableModel,
  isSonnetModel,
  modelSupportsMidConversationSystem,
} from "@/engine/model/facts/model-family.ts";
import { availableModelListing } from "@/engine/model/tier/available-models.ts";
import { isLeanPromptForModel } from "@/engine/providers/_shared/prompt-tier.ts";
import { list as listSkills } from "@/engine/skills/registry.ts";
import { agentRowsFromRegistry } from "@/engine/tools/dynamic/agent-roster.ts";
import { deferredToolNames } from "@/engine/tools/index.ts";
import * as toolsRegistry from "@/engine/tools/registry.ts";
import { sanitizeMessages } from "@/engine/translator/sanitize.ts";
import { providerToolDeclarations } from "@/engine/translator/tools.ts";
import type { AssembleArgs, ProviderTurn } from "@/engine/translator/types.ts";
import { buildHarness } from "@/harness/builder.ts";
import type { AgentRowData } from "@/harness/composer/injections.ts";
import { nestedMemoryFiles, renderMemorySection } from "@/harness/core/memory-section.ts";
import type { SkillListingEntry } from "@/harness/reminders/reminders.ts";
import { effectiveOrchestrationMode } from "@/kernel/config/config.ts";
import { getMcpInstructionBlocks, isMcpToolName } from "@/kernel/mcp/index.ts";
import { hasWholeToolDenyRule } from "@/kernel/permissions/index.ts";
import { loadRulesSync } from "@/kernel/permissions/persist.ts";
import type { PermissionRule } from "@/kernel/permissions/types.ts";
import { collectMemoryFiles } from "@/kernel/storage/memory/loader.ts";

function supportsMidConversationSystem(ctx: AssembleArgs["ctx"]): boolean {
  if (ctx.provider !== "anthropic") return false;
  return modelSupportsMidConversationSystem(parseModelId(ctx.model).base);
}

function modelFamilyFor(model: string): "fable" | "sonnet" | "other" {
  const base = parseModelId(model).base;
  if (isFableModel(base)) return "fable";
  if (isSonnetModel(base)) return "sonnet";
  return "other";
}

function activeMcpToolNames(permissionRules: readonly PermissionRule[]): string[] {
  return toolsRegistry
    .list()
    .map((handler) => handler.schema.name)
    .filter((name) => isMcpToolName(name) && !hasWholeToolDenyRule(permissionRules, name));
}

function skillListing(): SkillListingEntry[] {
  return listSkills()
    .filter((s) => s.modelInvocable)
    .map((s) => ({
      name: s.name,
      description: s.description,
      whenToUse: s.whenToUse,
      builtin: s.builtin,
    }));
}

function userContextMemorySection(
  projectFiles: ReturnType<typeof collectMemoryFiles>,
  nestedMemory: { path: string; content: string }[],
): string | null {
  const files = [...projectFiles, ...nestedMemoryFiles(nestedMemory)];
  return renderMemorySection(files);
}

function agentRows(): AgentRowData[] {
  return agentRowsFromRegistry().map((row) => ({
    agentType: row.agentType,
    whenToUse: row.whenToUse,
    ...(row.whenToUseLean !== undefined ? { whenToUseLean: row.whenToUseLean } : {}),
    toolsLabel: row.toolsLabel,
  }));
}

export function assembleProviderTurn(args: AssembleArgs): ProviderTurn {
  const { ctx, provider, messages, injections, config } = args;
  const permissionRules = loadRulesSync(ctx.cwd);
  const tools = providerToolDeclarations(provider, config, {
    model: ctx.model,
    mainAgent: ctx.agentOwnerId === undefined && ctx.isForkChild !== true,
    permissionRules,
  });
  const agentInPool = tools.some((tool) => tool.name === "Agent");
  const overrides = provider.deferredOverrides();
  const modelDisplayName = findModel(ctx.model)?.displayName;
  // Read the project memory files once; both the combined user-context section and
  // the project-only section derive from it (avoids a second per-turn disk read).
  const projectMemoryFiles = collectMemoryFiles(ctx.cwd);
  const orchestrationMode = ctx.orchestrationMode ?? effectiveOrchestrationMode(config);
  const harness = buildHarness({
    ctx: { ...ctx, orchestrationMode },
    promptAdapter: provider.promptAdapter(),
    facts: {
      config,
      deferredToolExclusions: new Set(overrides.excludeFromCatalog),
      emitDeferredReminder: overrides.emitDeferredReminder,
      emitAgentListing: agentInPool,
      injections,
      supportsMidSystem: supportsMidConversationSystem(ctx),
      lean: isLeanPromptForModel(provider.id, ctx.model),
      modelFamily: modelFamilyFor(ctx.model),
      availableModels:
        orchestrationMode === "feudalism"
          ? []
          : availableModelListing(orchestrationMode === "disabled" ? ctx.provider : undefined),
      knowledgeCutoff: knowledgeCutoffFor(ctx.model),
      agentRows: agentRows(),
      deferredToolNames: deferredToolNames(),
      deferredMcpToolNames: activeMcpToolNames(permissionRules),
      memorySection: userContextMemorySection(projectMemoryFiles, args.nestedMemory ?? []),
      projectMemorySection: renderMemorySection(projectMemoryFiles),
      mcpInstructionBlocks: getMcpInstructionBlocks(),
      skillListing: skillListing(),
      ...(modelDisplayName !== undefined ? { modelDisplayName } : {}),
      ...(args.nestedMemory !== undefined ? { nestedMemory: args.nestedMemory } : {}),
      ...(args.currentDate !== undefined ? { currentDate: args.currentDate } : {}),
      ...(args.gitStatus !== undefined ? { gitStatus: args.gitStatus } : {}),
    },
  });

  return {
    harness,
    messages: provider.composeMessages(
      harness,
      sanitizeMessages(messages, { preserveToolReferences: provider.id === "anthropic" }),
    ),
    tools,
  };
}
