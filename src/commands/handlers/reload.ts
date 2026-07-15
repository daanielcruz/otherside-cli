import type { SlashCommand } from "@/commands/catalog.ts";
import type { SlashContext, SlashResult } from "@/commands/types.ts";
import { clear as clearAgents } from "@/engine/agents/registry.ts";
import { loadCorpus } from "@/engine/corpus.ts";
import { gatherPluginLspServerSpecs } from "@/engine/plugins/lsp.ts";
import { gatherPluginMcpServers } from "@/engine/plugins/mcp.ts";
import {
  clear as clearPlugins,
  isRuntimeEnabled as isPluginRuntimeEnabled,
  list as listPlugins,
} from "@/engine/plugins/registry.ts";
import { clear as clearSkills } from "@/engine/skills/registry.ts";
import { refreshMcpTools } from "@/kernel/mcp/index.ts";
import { pluralize } from "@/kernel/std/text/pluralize.ts";

export function countPluginHooks(): number {
  let total = 0;
  for (const plugin of listPlugins()) {
    if (!isPluginRuntimeEnabled(plugin.name)) continue;
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
}): string {
  // Match reference category set + order:
  // plugins · skills · agents · hooks · plugin MCP servers · plugin LSP servers
  const parts = [
    `${counts.plugins} ${pluralize(counts.plugins, "plugin")}`,
    `${counts.skills} ${pluralize(counts.skills, "skill")}`,
    `${counts.agents} ${pluralize(counts.agents, "agent")}`,
    `${counts.hooks} ${pluralize(counts.hooks, "hook")}`,
    `${counts.mcpServers} ${pluralize(counts.mcpServers, "plugin MCP server")}`,
    `${counts.lspServers} ${pluralize(counts.lspServers, "plugin LSP server")}`,
  ];
  return `Reloaded: ${parts.join(" · ")}`;
}

export async function handleReload(
  cmd: SlashCommand,
  _args: string,
  _ctx: SlashContext,
): Promise<SlashResult> {
  clearSkills();
  clearAgents();
  clearPlugins();
  const { agents, skills, plugins } = loadCorpus();
  await refreshMcpTools(process.cwd());
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
    }),
  };
}
