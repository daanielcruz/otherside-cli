import { existsSync, rmSync } from "node:fs";
import { delimiter, join, resolve, sep } from "node:path";
import {
  agentLoadFailureText,
  loadAndRegister as loadAgent,
  loadFromMarkdown as loadAgentFromMarkdown,
  loadFromDirectory,
} from "@/engine/agents/loader.ts";
import * as agentRegistry from "@/engine/agents/registry.ts";
import { getPluginWorkflows } from "@/engine/background/workflows/runtime/plugins/plugin-workflows.ts";
import { listPluginInstallations } from "@/engine/plugins/installations.ts";
import {
  loadPluginsFromDirectories,
  type PluginLoadError,
  resolvePluginComponents,
} from "@/engine/plugins/loader.ts";
import { gatherPluginLspServerSpecs } from "@/engine/plugins/lsp.ts";
import { gatherPluginMcpServers } from "@/engine/plugins/mcp.ts";
import { schedulePluginPayloadSweep } from "@/engine/plugins/prune.ts";
import {
  applyPersistedEnabledState,
  isRuntimeEnabled as isPluginRuntimeEnabled,
  list as listPluginRegistry,
  pluginIdForPlugin,
  register as registerPlugin,
  replaceSnapshot as replacePluginRegistrySnapshot,
  snapshot as snapshotPluginRegistry,
} from "@/engine/plugins/registry.ts";
import type { LoadedPluginState } from "@/engine/plugins/state.ts";
import {
  clearErrors,
  getSnapshot,
  recordError,
  replaceDesiredState,
  replaceDiskState,
  replaceLoadedState,
  replaceSnapshot,
} from "@/engine/plugins/state.ts";
import { registerPluginUseListener } from "@/engine/plugins/usage.ts";
import {
  loadProjectCommandsFromDirectory,
  loadAndRegister as loadSkill,
  loadSkillFromMarkdown,
  readSkillsFromDir,
} from "@/engine/skills/loader.ts";
import * as skillRegistry from "@/engine/skills/registry.ts";
import { pruneAnnouncedMcpTools } from "@/engine/tools/deferred.ts";
import { list as listToolHandlers } from "@/engine/tools/registry.ts";
import explore from "@/harness/agents/fast-explorer/AGENT.md" with { type: "text" };
import generalPurpose from "@/harness/agents/generalist/AGENT.md" with { type: "text" };
import planAgent from "@/harness/agents/planner/AGENT.md" with { type: "text" };
import verifier from "@/harness/agents/verifier/AGENT.md" with { type: "text" };
import codeReviewSkill from "@/harness/skills/code-review/SKILL.md" with { type: "text" };
import deepSecurityReview from "@/harness/skills/deep-security-review/SKILL.md" with {
  type: "text",
};
import dreamSkill from "@/harness/skills/dream/SKILL.md" with { type: "text" };
import grillMeSkill from "@/harness/skills/grill-me/SKILL.md" with { type: "text" };
import initSkill from "@/harness/skills/init/SKILL.md" with { type: "text" };
import loopSkill from "@/harness/skills/loop/SKILL.md" with { type: "text" };
import prReviewSkill from "@/harness/skills/pr-review/SKILL.md" with { type: "text" };
import prSecurityReviewSkill from "@/harness/skills/pr-security-review/SKILL.md" with {
  type: "text",
};
import ultraplanSkill from "@/harness/skills/ultraplan/SKILL.md" with { type: "text" };
import type { UserConfig } from "@/kernel/config/config.ts";
import { resolveConfig } from "@/kernel/config/resolver.ts";
import { setPluginMcpServersProvider } from "@/kernel/mcp/config.ts";
import { refreshMcpTools } from "@/kernel/mcp/index.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { getTrackedCwd } from "@/kernel/std/state/cwd-state.ts";

const AGENT_CORPUS: { id: string; src: string }[] = [
  { id: "explore", src: explore },
  { id: "general-purpose", src: generalPurpose },
  { id: "plan", src: planAgent },
  { id: "verifier", src: verifier },
];

const SKILL_CORPUS: { name: string; src: string }[] = [
  { name: "init", src: initSkill },
  { name: "dream", src: dreamSkill },
  { name: "grill-me", src: grillMeSkill },
  { name: "loop", src: loopSkill },
  { name: "pr-review", src: prReviewSkill },
  { name: "pr-security-review", src: prSecurityReviewSkill },
  { name: "deep-security-review", src: deepSecurityReview },
  { name: "code-review", src: codeReviewSkill },
  { name: "ultraplan", src: ultraplanSkill },
];

// Session-only plugin dirs from `--plugin-dir` (set by modes/args.ts).
function cliPluginDirs(): string[] {
  const raw = process.env.OTHERSIDE_FLAG_PLUGIN_DIRS;
  if (!raw) return [];
  return raw.split(delimiter).filter((d) => d.length > 0);
}

export interface CorpusLoadOptions {
  readonly config?: UserConfig;
  readonly cwd?: string;
}

function desiredState(config: UserConfig): { enabled: string[]; disabled: string[] } {
  const enabled: string[] = [];
  const disabled: string[] = [];
  for (const [pluginId, value] of Object.entries(config.enabledPlugins ?? {})) {
    (value ? enabled : disabled).push(pluginId);
  }
  enabled.sort();
  disabled.sort();
  return { enabled, disabled };
}

function componentLoadError(pluginId: string, path: string, error: unknown): PluginLoadError {
  return {
    pluginId,
    path,
    stage: "components",
    code: "PLUGIN_COMPONENT_LOAD_FAILED",
    message: error instanceof Error ? error.message : String(error),
    recoveryHint: "Fix the plugin contribution file, then reload plugins.",
  };
}

type PluginRegistryEntries = ReturnType<typeof listPluginRegistry>;
type AgentSnapshot = ReturnType<typeof agentRegistry.snapshot>;
type SkillSnapshot = ReturnType<typeof skillRegistry.snapshot>;

interface PluginReloadCandidate {
  readonly entries: PluginRegistryEntries;
  readonly agentDefs: AgentSnapshot;
  readonly skills: SkillSnapshot;
  readonly loaded: LoadedPluginState;
  readonly agents: number;
  readonly skillsCount: number;
  readonly hooks: number;
  readonly mcpServers: number;
  readonly lspServers: number;
  readonly workflows: number;
}

function pluginContributionId(pluginId: string, id: string): string {
  return `${pluginId}:${id}`;
}

function isPluginContribution(id: string, pluginIds: ReadonlySet<string>): boolean {
  for (const pluginId of pluginIds) {
    if (id.startsWith(`${pluginId}:`)) return true;
  }
  return false;
}

function candidateRuntimeDisabled(
  entries: PluginRegistryEntries,
  persisted: Record<string, boolean> | undefined,
): Set<string> {
  const disabled = new Set<string>();
  const canonicalKeys = new Set(Object.keys(persisted ?? {}));
  for (const { pluginId } of entries) {
    if (canonicalKeys.has(pluginId) && persisted?.[pluginId] === false) disabled.add(pluginId);
  }
  for (const [target, value] of Object.entries(persisted ?? {})) {
    if (target.includes("@") || value !== false) continue;
    const matches = entries.filter(({ plugin }) => plugin.name === target);
    if (matches.length === 1 && !canonicalKeys.has(matches[0]!.pluginId)) {
      disabled.add(matches[0]!.pluginId);
    }
  }
  return disabled;
}

function pluginAgentAndSkillSnapshots(pluginIds: ReadonlySet<string>): {
  agents: AgentSnapshot;
  skills: SkillSnapshot;
} {
  return {
    agents: agentRegistry.snapshot().filter((def) => !isPluginContribution(def.id, pluginIds)),
    skills: skillRegistry
      .snapshot()
      .filter((skill) => !isPluginContribution(skill.name, pluginIds)),
  };
}

async function reloadCandidate(
  config: UserConfig,
  cwd: string,
  previousPluginIds: ReadonlySet<string>,
): Promise<PluginReloadCandidate> {
  const pluginDirs = [join(configRoot(), "plugins", "installed"), ...cliPluginDirs()];
  const pluginResult = loadPluginsFromDirectories(pluginDirs, { cwd });
  const entries = pluginResult.plugins.map((plugin) => ({
    pluginId: pluginIdForPlugin(plugin),
    plugin,
  }));
  const runtimeDisabled = candidateRuntimeDisabled(entries, config.enabledPlugins);
  const retained = pluginAgentAndSkillSnapshots(previousPluginIds);
  const agentDefs = [...retained.agents];
  const skills = [...retained.skills];
  const errors = [...pluginResult.errors];
  let agents = 0;
  let skillsCount = 0;

  for (const { pluginId, plugin } of entries) {
    if (runtimeDisabled.has(pluginId)) continue;
    let resolved: ReturnType<typeof resolvePluginComponents>;
    try {
      resolved = resolvePluginComponents(plugin);
    } catch (error) {
      errors.push(componentLoadError(pluginId, plugin.path, error));
      continue;
    }
    for (const agent of resolved.agents) {
      try {
        agentDefs.push(
          loadAgentFromMarkdown(
            pluginContributionId(pluginId, agent.id),
            agent.content,
            "user",
            agent.path,
          ),
        );
        agents += 1;
      } catch (error) {
        errors.push(componentLoadError(pluginId, agent.path, error));
      }
    }
    for (const skill of resolved.skills) {
      try {
        const skillId = pluginContributionId(pluginId, skill.name);
        const loadedSkill = loadSkillFromMarkdown(skillId, skill.content, false, "plugin");
        skills.push({ ...loadedSkill, name: skillId });
        skillsCount += 1;
      } catch (error) {
        errors.push(componentLoadError(pluginId, skill.path, error));
      }
    }
    for (const command of resolved.commands) {
      try {
        let content = command.content;
        if (!content.startsWith("---")) {
          const description = command.metadata?.description ?? "Plugin command";
          content = `---\ndescription: ${description}\n---\n${content}`;
        }
        const commandId = pluginContributionId(pluginId, command.name);
        const loadedCommand = loadSkillFromMarkdown(commandId, content, false, "plugin");
        skills.push({ ...loadedCommand, name: commandId });
        skillsCount += 1;
      } catch (error) {
        errors.push(componentLoadError(pluginId, command.path, error));
      }
    }
  }

  const enabledEntries = entries.filter(({ pluginId }) => !runtimeDisabled.has(pluginId));
  const enabled = enabledEntries.map(({ plugin }) => plugin);
  const disabled = entries
    .filter(({ pluginId }) => runtimeDisabled.has(pluginId))
    .map(({ plugin }) => plugin);
  let hooks = 0;
  for (const { plugin } of enabledEntries) {
    for (const hookEntries of Object.values(plugin.hooksConfig ?? {})) {
      hooks += hookEntries?.length ?? 0;
    }
  }
  const mcpServers = Object.keys(gatherPluginMcpServers({ entries: enabledEntries })).length;
  const lspServers = gatherPluginLspServerSpecs({ entries: enabledEntries }).length;
  const workflows = (await getPluginWorkflows({ entries: enabledEntries })).length;
  return {
    entries,
    agentDefs,
    skills,
    loaded: {
      enabled,
      disabled,
      errors,
      warnings: getSnapshot().warnings,
    },
    agents,
    skillsCount,
    hooks,
    mcpServers,
    lspServers,
    workflows,
  };
}

function restorePluginRuntime(
  pluginSnapshot: ReturnType<typeof snapshotPluginRegistry>,
  agentSnapshot: ReturnType<typeof agentRegistry.snapshot>,
  skillSnapshot: ReturnType<typeof skillRegistry.snapshot>,
): void {
  replacePluginRegistrySnapshot(pluginSnapshot);
  agentRegistry.replaceSnapshot(agentSnapshot);
  skillRegistry.replaceSnapshot(skillSnapshot);
}

function removeStaleManagedPayloads(
  previous: ReturnType<typeof snapshotPluginRegistry>,
  next: PluginRegistryEntries,
): void {
  const managedRoot = resolve(configRoot(), "plugins", "installed");
  const nextPaths = new Set(next.map(({ plugin }) => resolve(plugin.path)));
  const persistedPaths = new Set(
    listPluginInstallations().map((installation) => resolve(installation.installPath)),
  );
  for (const { plugin } of previous.entries) {
    const path = resolve(plugin.path);
    if (!path.startsWith(`${managedRoot}${sep}`) || nextPaths.has(path) || persistedPaths.has(path))
      continue;
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
}

export interface PluginReloadOptions {
  readonly refreshMcpTools?: (cwd: string) => Promise<void>;
}

export interface PluginReloadResult {
  readonly ok: boolean;
  readonly agents?: number;
  readonly skills?: number;
  readonly plugins?: number;
  readonly hooks?: number;
  readonly mcpServers?: number;
  readonly lspServers?: number;
  readonly workflows?: number;
  readonly error?: string;
}

export async function reloadPlugins(options?: PluginReloadOptions): Promise<PluginReloadResult> {
  const refresh = options?.refreshMcpTools ?? refreshMcpTools;
  const beforeState = getSnapshot();
  const beforePlugins = snapshotPluginRegistry();
  const beforeAgents = agentRegistry.snapshot();
  const beforeSkills = skillRegistry.snapshot();
  const cwd = getTrackedCwd();
  let activeMutationStarted = false;

  const fail = (error: unknown): PluginReloadResult => {
    restorePluginRuntime(beforePlugins, beforeAgents, beforeSkills);
    replaceSnapshot({ ...beforeState, needsRefresh: true });
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  };

  try {
    const config = resolveConfig(cwd);
    const previousPluginIds = new Set(beforePlugins.entries.map(({ pluginId }) => pluginId));
    const candidate = await reloadCandidate(config, cwd, previousPluginIds);
    replaceDesiredState(desiredState(config));
    replaceDiskState({ installations: listPluginInstallations() });

    activeMutationStarted = true;
    replacePluginRegistrySnapshot({
      entries: candidate.entries,
      desiredDisabled: candidate.entries
        .filter(({ plugin }) => candidate.loaded.disabled.includes(plugin))
        .map(({ pluginId }) => pluginId),
      runtimeDisabled: candidate.entries
        .filter(({ plugin }) => candidate.loaded.disabled.includes(plugin))
        .map(({ pluginId }) => pluginId),
    });
    agentRegistry.replaceSnapshot(candidate.agentDefs);
    skillRegistry.replaceSnapshot(candidate.skills);
    setPluginMcpServersProvider(gatherPluginMcpServers);
    registerPluginUseListener();
    await refresh(cwd);
    pruneAnnouncedMcpTools(new Set(listToolHandlers().map((handler) => handler.schema.name)));
    replaceLoadedState(candidate.loaded);
    removeStaleManagedPayloads(beforePlugins, candidate.entries);
    return {
      ok: true,
      agents: candidate.agents,
      skills: candidate.skillsCount,
      plugins: candidate.entries.length,
      hooks: candidate.hooks,
      mcpServers: candidate.mcpServers,
      lspServers: candidate.lspServers,
      workflows: candidate.workflows,
    };
  } catch (error) {
    if (activeMutationStarted) {
      restorePluginRuntime(beforePlugins, beforeAgents, beforeSkills);
      try {
        await refresh(cwd);
      } catch {}
    }
    return fail(error);
  }
}

export function loadCorpus(options?: CorpusLoadOptions): {
  agents: number;
  skills: number;
  plugins: number;
  agentFailures: string[];
} {
  const cwd = options?.cwd ?? process.cwd();
  const config = options?.config ?? resolveConfig(cwd);
  replaceDesiredState(desiredState(config));
  clearErrors();

  let agents = 0;
  for (const { id, src } of AGENT_CORPUS) {
    try {
      loadAgent(id, src, "builtin");
      agents += 1;
    } catch {}
  }
  const userAgents = loadFromDirectory(join(configRoot(), "agents"), "user");
  const projectAgents = loadFromDirectory(join(cwd, ".otherside", "agents"), "project");
  agents += userAgents.defs.length + projectAgents.defs.length;
  const agentFailures = [...userAgents.failures, ...projectAgents.failures].map(
    agentLoadFailureText,
  );
  let skills = 0;
  for (const { name, src } of SKILL_CORPUS) {
    try {
      loadSkill(name, src, true);
      skills += 1;
    } catch {}
  }
  skills += readSkillsFromDir(join(configRoot(), "skills"));
  skills += readSkillsFromDir(join(cwd, ".otherside", "skills"), "project");
  skills += loadProjectCommandsFromDirectory(join(cwd, ".otherside", "commands"));

  const pluginDirs = [join(configRoot(), "plugins", "installed"), ...cliPluginDirs()];
  const pluginResult = loadPluginsFromDirectories(pluginDirs, { cwd });
  for (const error of pluginResult.errors) recordError(error);
  for (const plugin of pluginResult.plugins) registerPlugin(plugin);
  applyPersistedEnabledState(config.enabledPlugins);
  try {
    replaceDiskState({ installations: listPluginInstallations() });
  } catch (error) {
    recordError({
      path: join(configRoot(), "plugins", "installed_plugins.json"),
      stage: "discovery",
      code: "PLUGIN_REGISTRY_INVALID",
      message: error instanceof Error ? error.message : String(error),
      recoveryHint: "Repair or remove the installed plugin registry, then reload plugins.",
    });
    replaceDiskState({ installations: [] });
  }

  let plugins = 0;
  const enabledPlugins = new Set(
    pluginResult.plugins.filter((plugin) => {
      const entry = listPluginRegistry().find((candidate) => candidate.plugin === plugin);
      return entry !== undefined && isPluginRuntimeEnabled(entry.pluginId);
    }),
  );
  for (const plugin of pluginResult.plugins) {
    const registryEntry = listPluginRegistry().find((entry) => entry.plugin === plugin);
    const pluginId = registryEntry?.pluginId;
    if (!pluginId || !enabledPlugins.has(plugin)) {
      plugins += 1;
      continue;
    }
    let resolved: ReturnType<typeof resolvePluginComponents>;
    try {
      resolved = resolvePluginComponents(plugin);
    } catch (error) {
      recordError(componentLoadError(pluginId, plugin.path, error));
      plugins += 1;
      continue;
    }
    for (const agent of resolved.agents) {
      try {
        loadAgent(`${pluginId}:${agent.id}`, agent.content, "user", agent.path);
        agents += 1;
      } catch (error) {
        recordError(componentLoadError(pluginId, agent.path, error));
      }
    }
    for (const skill of resolved.skills) {
      try {
        const skillId = `${pluginId}:${skill.name}`;
        const loadedSkill = loadSkillFromMarkdown(skillId, skill.content, false);
        skillRegistry.register({ ...loadedSkill, name: skillId });
        skills += 1;
      } catch (error) {
        recordError(componentLoadError(pluginId, skill.path, error));
      }
    }
    for (const cmd of resolved.commands) {
      try {
        let content = cmd.content;
        if (!content.startsWith("---")) {
          const desc = cmd.metadata?.description ?? "Plugin command";
          content = `---\ndescription: ${desc}\n---\n${content}`;
        }
        const commandId = `${pluginId}:${cmd.name}`;
        const loadedCommand = loadSkillFromMarkdown(commandId, content, false);
        skillRegistry.register({ ...loadedCommand, name: commandId });
        skills += 1;
      } catch (error) {
        recordError(componentLoadError(pluginId, cmd.path, error));
      }
    }
    plugins += 1;
  }

  replaceLoadedState({
    enabled: listPluginRegistry()
      .filter((entry) => isPluginRuntimeEnabled(entry.pluginId))
      .map((entry) => entry.plugin),
    disabled: listPluginRegistry()
      .filter((entry) => !isPluginRuntimeEnabled(entry.pluginId))
      .map((entry) => entry.plugin),
    errors: getSnapshot().errors,
    warnings: getSnapshot().warnings,
  });
  setPluginMcpServersProvider(gatherPluginMcpServers);
  registerPluginUseListener();
  // Deferred plugin-payload cleanup: uninstall only stamps payload dirs with
  // an orphan marker; this startup sweep deletes dirs whose marker outlived
  // the retention window (and un-stamps anything that was reinstalled).
  schedulePluginPayloadSweep(cwd);

  return { agents, skills, plugins, agentFailures };
}
