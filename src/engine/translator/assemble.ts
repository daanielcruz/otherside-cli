import { findModel, parseModelId } from "@/engine/model/catalog.ts";
import { knowledgeCutoffFor } from "@/engine/model/facts/knowledge-cutoff.ts";
import {
  isFableModel,
  isSonnetModel,
  modelSupportsMidConversationSystem,
  modelSupportsMidConversationSystemBeta,
} from "@/engine/model/facts/model-family.ts";
import { availableModelListing } from "@/engine/model/tier/available-models.ts";
import { resolveOutputStyle } from "@/engine/output-styles/loader.ts";
import { isLeanPromptForModel } from "@/engine/providers/_shared/prompt-tier.ts";
import { modelSkillListingMode } from "@/engine/skills/overrides.ts";
import { list as listSkills } from "@/engine/skills/registry.ts";
import { agentRowsFromRegistry } from "@/engine/tools/dynamic/agent-roster.ts";
import { deferredToolNames } from "@/engine/tools/index.ts";
import * as toolsRegistry from "@/engine/tools/registry.ts";
import { sanitizeMessages } from "@/engine/translator/sanitize.ts";
import { providerToolDeclarations } from "@/engine/translator/tools.ts";
import type { AssembleArgs, ProviderTurn } from "@/engine/translator/types.ts";
import { buildHarness } from "@/harness/builder.ts";
import type { AgentRowData, MidSystemPromotion } from "@/harness/composer/injections.ts";
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

// Promotion follows the beta gate: an anthropic model that carries the
// mid-conversation-system beta promotes reminders to system messages; haiku
// (no beta, API rejects mid-conversation system roles) keeps them in user
// blocks. Shared with the subagent composer, which delivers its own reminders.
export function midSystemPromotionFor(
  ctx: Pick<AssembleArgs["ctx"], "provider" | "model">,
): MidSystemPromotion {
  if (ctx.provider !== "anthropic") return "off";
  const base = parseModelId(ctx.model).base;
  if (!modelSupportsMidConversationSystemBeta(base)) return "off";
  return modelSupportsMidConversationSystem(base) ? "unwrapped" : "wrapped";
}

function promotesMidSystem(ctx: AssembleArgs["ctx"]): boolean {
  return midSystemPromotionFor(ctx) !== "off";
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
    .filter((s) => s.modelInvocable && modelSkillListingMode(s) !== "hidden")
    .map((s) => ({
      name: s.name,
      // A name-only override advertises the skill without its guidance.
      description: modelSkillListingMode(s) === "full" ? s.description : "",
      whenToUse: modelSkillListingMode(s) === "full" ? s.whenToUse : "",
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
  const orchestrationMode = ctx.orchestrationMode ?? effectiveOrchestrationMode(config);
  const tools = providerToolDeclarations(provider, config, {
    model: ctx.model,
    mainAgent: ctx.agentOwnerId === undefined && ctx.isForkChild !== true,
    permissionRules,
    orchestrationMode,
  });
  const agentInPool = tools.some((tool) => tool.name === "Agent");
  const overrides = provider.deferredOverrides();
  const modelDisplayName = findModel({ provider: ctx.provider, model: ctx.model })?.displayName;
  // Read the project memory files once; both the combined user-context section and
  // the project-only section derive from it (avoids a second per-turn disk read).
  const projectMemoryFiles = collectMemoryFiles(ctx.cwd);
  const harness = buildHarness({
    ctx: { ...ctx, orchestrationMode },
    promptAdapter: provider.promptAdapter(),
    facts: {
      config,
      outputStyle: resolveOutputStyle(config.outputStyle, ctx.cwd),
      deferredToolExclusions: new Set(overrides.excludeFromCatalog),
      emitDeferredReminder: overrides.emitDeferredReminder,
      emitAgentListing: agentInPool,
      injections,
      promoteMidSystem: promotesMidSystem(ctx),
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
      // Preserved tool_reference blocks must name tools declared in THIS
      // request's toolset; anything else (e.g. a tool since denied or no
      // longer declared) is stripped from the outgoing body only.
      sanitizeMessages(messages, {
        preserveToolReferences: provider.id === "anthropic",
        declaredToolNames: new Set(tools.map((tool) => tool.name)),
      }),
    ),
    tools,
  };
}
