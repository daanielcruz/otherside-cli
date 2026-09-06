import type { SlashCommand } from "@/commands/catalog.ts";
import type { SlashContext, SlashResult } from "@/commands/types.ts";
import { clear as clearAgents } from "@/engine/agents/registry.ts";
import { loadCorpus, reloadPlugins } from "@/engine/corpus.ts";
import { gatherPluginLspServerSpecs } from "@/engine/plugins/lsp.ts";
import { gatherPluginMcpServers } from "@/engine/plugins/mcp.ts";
import {
  clear as clearPlugins,
  isRuntimeEnabled as isPluginRuntimeEnabled,
  list as listPlugins,
} from "@/engine/plugins/registry.ts";
import { clear as clearSkills } from "@/engine/skills/registry.ts";
import { resolveConfig } from "@/kernel/config/resolver.ts";

import { pluralize } from "@/kernel/std/text/pluralize.ts";

export function countPluginHooks(): number {
  let total = 0;
  for (const { pluginId, plugin } of listPlugins()) {
    if (!isPluginRuntimeEnabled(pluginId)) continue;
    const config = plugin.hooksConfig;
    if (!config) continue;
    for (const entries of Object.values(config)) {
      if (Array.isArray(entries)) total += entries.length;
    }
  }
  return total;
}

export function formatReloadFeedback(counts: {
  plugins: number;
  skills: number;
  agents: number;
  hooks: number;
  mcpServers: number;
  lspServers: number;
  agentFailures?: readonly string[];
}): string {
  // Category set + order:
  // plugins · skills · agents · hooks · plugin MCP servers · plugin LSP servers
  const parts = [
    `${counts.plugins} ${pluralize(counts.plugins, "plugin")}`,
    `${counts.skills} ${pluralize(counts.skills, "skill")}`,
    `${counts.agents} ${pluralize(counts.agents, "agent")}`,
    `${counts.hooks} ${pluralize(counts.hooks, "hook")}`,
    `${counts.mcpServers} ${pluralize(counts.mcpServers, "plugin MCP server")}`,
    `${counts.lspServers} ${pluralize(counts.lspServers, "plugin LSP server")}`,
  ];
  // A file that failed to parse is silently absent from the counts, so the
  // reload feedback is the only place the user learns it was skipped.
  const failures = counts.agentFailures ?? [];
  return [`Reloaded: ${parts.join(" · ")}`, ...failures].join("\n");
}

export async function handleReload(
  cmd: SlashCommand,
  _args: string,
  ctx: SlashContext,
): Promise<SlashResult> {
  const cwd = process.cwd();
  const config = ctx.config ?? resolveConfig(cwd);
  clearSkills();
  clearAgents();
  clearPlugins();
  const { agents, skills, plugins, agentFailures } = loadCorpus({ config, cwd });
  // Plugin runtime state swaps transactionally: MCP clients and deferred tool
  // announcements for removed servers are cleaned up, and a failed swap rolls
  // back to the freshly loaded corpus with needsRefresh re-armed.
  const result = await reloadPlugins();
  if (!result.ok) {
    return {
      kind: "instant",
      command: cmd,
      feedback: `Plugin reload failed: ${result.error ?? "unknown error"}`,
    };
  }
  const hooks = countPluginHooks();
  const mcpServers = Object.keys(gatherPluginMcpServers()).length;
  const lspServers = gatherPluginLspServerSpecs().length;
  return {
    kind: "instant",
    command: cmd,
    feedback: formatReloadFeedback({
      plugins,
      skills,
      agents,
      hooks,
      mcpServers,
      lspServers,
      agentFailures,
    }),
  };
}
