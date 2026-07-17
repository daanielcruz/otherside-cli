import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFromMarkdown as loadAgentFromMarkdown } from "@/engine/agents/loader.ts";
import * as agentRegistry from "@/engine/agents/registry.ts";
import { getPluginWorkflows } from "@/engine/background/workflows/runtime/plugins/plugin-workflows.ts";
import { reloadPlugins } from "@/engine/corpus.ts";
import { installPlugin, removePlugin } from "@/engine/plugins/install.ts";
import {
  activeInstallPath,
  cachePathForPlugin,
  listPluginInstallations,
  recordPluginInstallation,
} from "@/engine/plugins/installations.ts";
import {
  type LoadedPlugin,
  loadPluginFromDirectory,
  resolvePluginComponents,
} from "@/engine/plugins/loader.ts";
import { gatherPluginLspServerSpecs } from "@/engine/plugins/lsp.ts";
import { gatherPluginMcpServers } from "@/engine/plugins/mcp.ts";
import * as pluginRegistry from "@/engine/plugins/registry.ts";
import {
  getSnapshot,
  pluginStateStore,
  replaceDiskState,
  replaceLoadedState,
} from "@/engine/plugins/state.ts";
import { loadSkillFromMarkdown } from "@/engine/skills/loader.ts";
import * as skillRegistry from "@/engine/skills/registry.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { getTrackedCwd, setTrackedCwd } from "@/kernel/std/state/cwd-state.ts";

const PLUGIN_ID = "demo@local";

let root = "";
let project = "";
let previousConfigRoot: string | undefined;
let previousTrackedCwd = "";

function writePlugin(dir: string, version: string, marker: string): void {
  mkdirSync(join(dir, "commands"), { recursive: true });
  mkdirSync(join(dir, "agents"), { recursive: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  mkdirSync(join(dir, "workflows"), { recursive: true });
  writeFileSync(
    join(dir, "plugin.json"),
    JSON.stringify({
      name: "demo",
      version,
      hooks: { preToolUse: [{ matcher: "*", command: `${marker}-hook` }] },
      mcpServers: { api: { url: "http://127.0.0.1:1/mcp" } },
      lspServers: {
        language: { command: `${marker}-language-server`, extensions: [`.${marker}`] },
      },
    }),
  );
  writeFileSync(join(dir, "commands", "run.md"), `${marker} command`);
  writeFileSync(
    join(dir, "agents", "reviewer.md"),
    `---\nname: Reviewer\ndescription: ${marker} reviewer\n---\n${marker} agent`,
  );
  writeFileSync(
    join(dir, "skills", "review.md"),
    `---\ndescription: ${marker} skill\n---\n${marker} skill`,
  );
  writeFileSync(
    join(dir, "workflows", "review.js"),
    `export const meta = { name: "review", description: "${marker} workflow" }`,
  );
}

function installManaged(version: string, marker: string): LoadedPlugin {
  const source = join(root, `source-${version}`);
  writePlugin(source, version, marker);
  const installPath = activeInstallPath("demo", "user", "local", version);
  mkdirSync(join(installPath, ".."), { recursive: true });
  cpSync(source, installPath, { recursive: true });
  recordPluginInstallation({
    pluginId: PLUGIN_ID,
    scope: "user",
    version,
    installPath,
    cachePath: cachePathForPlugin("local", "demo", version),
  });
  const plugin = loadPluginFromDirectory(installPath, PLUGIN_ID, {
    requireManifest: true,
  });
  if (!plugin) throw new Error(`failed to load managed ${version} plugin`);
  return plugin;
}

function activate(plugin: LoadedPlugin): void {
  pluginRegistry.register(plugin);
  const components = resolvePluginComponents(plugin);
  const id = pluginRegistry.pluginIdForPlugin(plugin);
  for (const agent of components.agents) {
    agentRegistry.register(
      loadAgentFromMarkdown(`${id}:${agent.id}`, agent.content, "user", agent.path),
    );
  }
  for (const skill of components.skills) {
    const skillId = `${id}:${skill.name}`;
    const loaded = loadSkillFromMarkdown(skillId, skill.content, false);
    skillRegistry.register({ ...loaded, name: skillId });
  }
  for (const command of components.commands) {
    const commandId = `${id}:${command.name}`;
    const loaded = loadSkillFromMarkdown(
      commandId,
      `---\ndescription: command\n---\n${command.content}`,
      false,
    );
    skillRegistry.register({ ...loaded, name: commandId });
  }
  replaceLoadedState({
    enabled: [plugin],
    disabled: [],
    errors: [],
    warnings: [],
  });
  replaceDiskState({ installations: listPluginInstallations() });
  pluginStateStore.markNeedsRefresh(false);
}

function writeUserConfig(enabled: boolean): void {
  mkdirSync(configRoot(), { recursive: true });
  writeFileSync(
    join(configRoot(), "settings.json"),
    JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: enabled } }),
  );
}

function writeProjectConfig(enabled: boolean): void {
  mkdirSync(join(project, ".otherside"), { recursive: true });
  writeFileSync(
    join(project, ".otherside", "settings.json"),
    JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: enabled } }),
  );
}

beforeEach(() => {
  previousConfigRoot = process.env.OTHERSIDE_CONFIG_DIR;
  previousTrackedCwd = getTrackedCwd();
  root = mkdtempSync(join(tmpdir(), "otherside-plugin-lifecycle-"));
  project = join(root, "project");
  mkdirSync(project, { recursive: true });
  process.env.OTHERSIDE_CONFIG_DIR = join(root, "config");
  setTrackedCwd(project);
  pluginRegistry.clear();
  agentRegistry.clear();
  skillRegistry.clear();
  pluginStateStore.replaceSnapshot({
    enabled: [],
    disabled: [],
    errors: [],
    warnings: [],
    desired: { enabled: [], disabled: [] },
    disk: { installations: [] },
    installationStatus: { marketplaces: [], plugins: [] },
    needsRefresh: false,
  });
});

afterEach(() => {
  pluginRegistry.clear();
  agentRegistry.clear();
  skillRegistry.clear();
  if (previousConfigRoot === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = previousConfigRoot;
  setTrackedCwd(previousTrackedCwd);
  rmSync(root, { recursive: true, force: true });
});

describe("staged plugin lifecycle", () => {
  it("install leaves every active contribution unchanged until reload while disk+needsRefresh update", () => {
    writeUserConfig(true);
    const source = join(root, "new-source");
    writePlugin(source, "1.0.0", "new");
    const beforeRegistry = pluginRegistry.snapshot();
    const beforeAgents = agentRegistry.snapshot();
    const beforeSkills = skillRegistry.snapshot();

    const result = installPlugin(source, { cwd: project });

    expect(result.success).toBe(true);
    expect(pluginRegistry.snapshot()).toEqual(beforeRegistry);
    expect(agentRegistry.snapshot()).toEqual(beforeAgents);
    expect(skillRegistry.snapshot()).toEqual(beforeSkills);
    expect(getSnapshot().disk.installations.map((entry) => entry.identity)).toEqual([PLUGIN_ID]);
    expect(getSnapshot().needsRefresh).toBe(true);
  });

  it("rejects a repeated local install in the same scope without changing active state", () => {
    writeUserConfig(true);
    const oldPlugin = installManaged("1.0.0", "old");
    activate(oldPlugin);
    const source = join(root, "update-source");
    writePlugin(source, "2.0.0", "new");

    const result = installPlugin(source, { cwd: project });

    expect(result).toMatchObject({
      success: false,
      message:
        "Plugin 'demo@local' is already installed. Use '/plugin' to manage existing plugins.",
    });
    expect(pluginRegistry.get(PLUGIN_ID)).toBe(oldPlugin);
    expect(resolvePluginComponents(pluginRegistry.get(PLUGIN_ID)!).commands[0]?.content).toBe(
      "old command",
    );
    expect(listPluginInstallations().find((entry) => entry.identity === PLUGIN_ID)?.version).toBe(
      "1.0.0",
    );
    expect(getSnapshot().needsRefresh).toBe(false);
  });

  it("uninstall keeps the active contribution until reload, then removes it", async () => {
    writeUserConfig(true);
    const oldPlugin = installManaged("1.0.0", "old");
    activate(oldPlugin);
    const activePath = oldPlugin.path;

    const result = await removePlugin(PLUGIN_ID);

    expect(result.success).toBe(true);
    expect(pluginRegistry.get(PLUGIN_ID)).toBe(oldPlugin);
    expect(existsSync(activePath)).toBe(true);
    expect(listPluginInstallations()).toEqual([]);
    expect(getSnapshot().needsRefresh).toBe(true);

    const reloaded = await reloadPlugins({ refreshMcpTools: async () => {} });

    expect(reloaded.ok).toBe(true);
    expect(pluginRegistry.get(PLUGIN_ID)).toBeUndefined();
    expect(skillRegistry.get(`${PLUGIN_ID}:run`)).toBeUndefined();
    expect(existsSync(activePath)).toBe(false);
    expect(getSnapshot().needsRefresh).toBe(false);
  });

  it("dedicated reload uses tracked cwd when process cwd differs and applies fresh layered config", async () => {
    writeUserConfig(false);
    writeProjectConfig(true);
    const plugin = installManaged("1.0.0", "tracked");
    const calls: string[] = [];

    const result = await reloadPlugins({
      refreshMcpTools: async (cwd) => {
        calls.push(cwd);
      },
    });

    expect(project).not.toBe(process.cwd());
    expect(result.ok).toBe(true);
    expect(calls).toEqual([project]);
    expect(pluginRegistry.get(PLUGIN_ID)?.path).toBe(plugin.path);
    expect(pluginRegistry.isRuntimeEnabled(PLUGIN_ID)).toBe(true);
    expect(skillRegistry.get(`${PLUGIN_ID}:run`)).toBeDefined();
    expect(getSnapshot().desired.enabled).toEqual([PLUGIN_ID]);
    expect(getSnapshot().needsRefresh).toBe(false);
  });

  it("successful reload swaps commands/agents/skills/hooks/MCP/LSP/workflows consistently and clears needsRefresh", async () => {
    writeUserConfig(true);
    installManaged("1.0.0", "fresh");

    const result = await reloadPlugins({ refreshMcpTools: async () => {} });
    const workflows = await getPluginWorkflows();
    const hooks = pluginRegistry.listEnabledHookEntries("preToolUse");
    const mcp = gatherPluginMcpServers();
    const lsp = gatherPluginLspServerSpecs();

    expect(result.ok).toBe(true);
    expect(skillRegistry.get(`${PLUGIN_ID}:run`)).toBeDefined();
    expect(agentRegistry.get(`${PLUGIN_ID}:reviewer`)).toBeDefined();
    expect(hooks).toHaveLength(1);
    expect(Object.keys(mcp)).toEqual([`plugin:${PLUGIN_ID}:api`]);
    expect((lsp[0] as { pluginId?: string } | undefined)?.pluginId).toBe(PLUGIN_ID);
    expect(workflows.map((workflow) => workflow.name)).toEqual([`${PLUGIN_ID}:review`]);
    expect(getSnapshot().enabled.map((plugin) => plugin.name)).toEqual(["demo"]);
    expect(getSnapshot().needsRefresh).toBe(false);
  });

  it("forced catastrophic reload restores exact previous snapshots and keeps needsRefresh", async () => {
    writeUserConfig(true);
    const oldPlugin = installManaged("1.0.0", "old");
    activate(oldPlugin);
    expect((await removePlugin(PLUGIN_ID)).success).toBe(true);

    const beforePlugins = pluginRegistry.snapshot();
    const beforeAgents = agentRegistry.snapshot();
    const beforeSkills = skillRegistry.snapshot();
    const beforeState = getSnapshot();
    const result = await reloadPlugins({
      refreshMcpTools: async () => {
        throw new Error("forced MCP refresh failure");
      },
    });

    expect(result.ok).toBe(false);
    expect(pluginRegistry.snapshot()).toEqual(beforePlugins);
    expect(agentRegistry.snapshot()).toEqual(beforeAgents);
    expect(skillRegistry.snapshot()).toEqual(beforeSkills);
    expect(getSnapshot().enabled).toEqual(beforeState.enabled);
    expect(getSnapshot().disk).toEqual(beforeState.disk);
    expect(getSnapshot().needsRefresh).toBe(true);
    expect(pluginRegistry.get(PLUGIN_ID)).toBe(oldPlugin);
  });
});
