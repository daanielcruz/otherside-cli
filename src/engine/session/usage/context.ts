import * as agentsRegistry from "@/engine/agents/registry.ts";
import { getProviderConfig } from "@/engine/contract/registry.ts";
import { findModel } from "@/engine/model/catalog.ts";
import { harnessBaselineBreakdown } from "@/engine/session/compact/harness-baseline.ts";
import { estimateTokens } from "@/engine/session/compact/token-count.ts";
import type { UsageWarning } from "@/engine/session/usage/limits.ts";
import { providerContextWarning } from "@/engine/session/usage/provider.ts";
import { list as listSkills } from "@/engine/skills/registry.ts";
import { renderMemorySection } from "@/harness/core/memory-section.ts";
import { renderSkillsReminder } from "@/harness/reminders/reminders.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { ContentBlock, Message } from "@/kernel/std/types/message.ts";
import { collectMemoryFiles } from "@/kernel/storage/memory/loader.ts";

export type ContextCategoryColor =
  | "steel"
  | "muted"
  | "success"
  | "warning"
  | "inlineCode"
  | "primary"
  | "subtle";

export interface ContextUsageCategory {
  name: string;
  tokens: number;
  color: ContextCategoryColor;
}

export interface ContextUsageData {
  modelLabel: string;
  modelId: string;
  totalTokens: number;
  windowTokens: number;
  categories: ContextUsageCategory[];
}

interface ContextWindowWarningArgs {
  provider: ProviderId;
  model: string;
  totals: {
    inputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
  suppressed: boolean;
}

export function contextWindowWarning({
  provider,
  model,
  totals,
  suppressed,
}: ContextWindowWarningArgs): UsageWarning | null {
  if (suppressed) return null;
  if (getProviderConfig(provider)?.usageDetails?.hasPlanPanel) return null;
  const contextTokens =
    totals.inputTokens + totals.cacheReadInputTokens + totals.cacheCreationInputTokens;
  if (contextTokens <= 0) return null;
  return providerContextWarning(provider, model, contextTokens);
}

export interface ContextBreakdownInput {
  provider: ProviderId;
  model: string;
  messages: Message[];
  serverInputTokens: number;
}

interface MessageTokenBreakdown {
  total: number;
  user: number;
  assistant: number;
  toolUse: number;
  toolResult: number;
  thinking: number;
  other: number;
}

export function getContextBreakdown(input: ContextBreakdownInput): ContextUsageData {
  const { provider, model: modelId, messages, serverInputTokens } = input;
  const model = findModel(modelId, provider);
  const window = model?.contextWindow ?? 0;
  const tokens = countContextBreakdown(messages);
  const harness = harnessBaselineBreakdown(provider, modelId);
  const auxiliary = auxiliarySectionTokens();
  const estimatedTotal =
    tokens.total +
    harness.systemTokens +
    harness.toolDefTokens +
    auxiliary.customAgents +
    auxiliary.memoryFiles +
    auxiliary.skills;
  const totalTokens = serverInputTokens > 0 ? serverInputTokens : estimatedTotal;
  const free = Math.max(0, window - totalTokens);
  const modelLabel = model
    ? model.id.endsWith("[1m]")
      ? `${model.displayName} (1M context)`
      : model.displayName
    : modelId;
  const allCategories: ContextUsageData["categories"] = [
    { name: "System prompt", tokens: harness.systemTokens, color: "steel" },
    { name: "System tools", tokens: harness.toolDefTokens, color: "muted" },
    { name: "Custom agents", tokens: auxiliary.customAgents, color: "success" },
    { name: "Memory files", tokens: auxiliary.memoryFiles, color: "warning" },
    { name: "Skills", tokens: auxiliary.skills, color: "inlineCode" },
    { name: "Messages", tokens: tokens.total, color: "primary" },
    { name: "Free space", tokens: free, color: "subtle" },
  ];
  const categories = allCategories.filter(
    (c) => c.tokens > 0 || c.name === "Free space" || c.name === "Messages",
  );
  return { modelLabel, modelId, totalTokens, windowTokens: window, categories };
}

function countContextBreakdown(messages: Message[]): MessageTokenBreakdown {
  const out: MessageTokenBreakdown = {
    total: 0,
    user: 0,
    assistant: 0,
    toolUse: 0,
    toolResult: 0,
    thinking: 0,
    other: 0,
  };
  for (const msg of messages) {
    for (const block of msg.content) {
      const blockTokens = estimateBlockTokens(block);
      out.total += blockTokens;
      if (block.type === "text") {
        if (msg.role === "user") out.user += blockTokens;
        else if (msg.role === "assistant") out.assistant += blockTokens;
        else out.other += blockTokens;
      } else if (block.type === "tool_use") {
        out.toolUse += blockTokens;
      } else if (block.type === "tool_result") {
        out.toolResult += blockTokens;
      } else if (block.type === "thinking") {
        out.thinking += blockTokens;
      } else {
        out.other += blockTokens;
      }
    }
  }
  return out;
}

function estimateBlockTokens(block: ContentBlock): number {
  return estimateTokens([{ content: [block] }]);
}

function auxiliarySectionTokens(): {
  customAgents: number;
  memoryFiles: number;
  skills: number;
} {
  return {
    customAgents: estimateTextTokens(renderCustomAgentsBlock()),
    memoryFiles: estimateTextTokens(renderMemoryFilesBlock()),
    skills: estimateTextTokens(renderSkillsBlock()),
  };
}

function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  return estimateTokens([{ content: [{ type: "text", text }] }]);
}

function renderCustomAgentsBlock(): string {
  const defs = agentsRegistry.list();
  if (defs.length === 0) return "";
  const lines = defs.map((def) => `${def.id}: ${def.description ?? ""}\n${def.body ?? ""}`);
  return lines.join("\n\n");
}

function renderMemoryFilesBlock(): string {
  try {
    const out = renderMemorySection(collectMemoryFiles(process.cwd()));
    return typeof out === "string" ? out : "";
  } catch {
    return "";
  }
}

function renderSkillsBlock(): string {
  try {
    const skills = listSkills()
      .filter((s) => s.modelInvocable)
      .map((s) => ({
        name: s.name,
        description: s.description,
        whenToUse: s.whenToUse,
        builtin: s.builtin,
      }));
    return renderSkillsReminder(skills);
  } catch {
    return "";
  }
}
