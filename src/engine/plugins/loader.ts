import { readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { getTrackedCwd } from "@/kernel/std/state/cwd-state.ts";
import {
  collectMdFiles,
  collectMdPath,
  collectSkillEntries,
  collectSkillPath,
  existsAt,
  isDirectory,
  isFile,
  readJsonFile,
} from "./component-files.ts";
import { type HooksSettings, loadHooks } from "./hooks-normalize.ts";
import {
  canonicalProjectPath,
  createPluginId,
  isPluginId,
  type PluginId,
  parsePluginId,
} from "./identity.ts";
import { findPluginInstallationByPath, listPluginInstallations } from "./installations.ts";
import { type CommandMetadata, type PluginManifest, parseManifest } from "./manifest.ts";

export type { HooksSettings } from "./hooks-normalize.ts";

export interface LoadedPlugin {
  name: string;
  path: string;
  source: string;
  manifest: PluginManifest;
  commandsPath?: string;
  agentsPath?: string;
  skillsPath?: string;
  workflowsPath?: string;
  outputStylesPath?: string;
  /** Style directories the manifest named beyond the plugin's own. */
  outputStylesPaths?: string[];
  themesPath?: string;
  /** Palette directories the manifest named beyond the plugin's own. */
  themesPaths?: string[];
  hooksConfig?: HooksSettings;
}

export interface ResolvedCommand {
  name: string;
  path: string;
  content: string;
  metadata?: CommandMetadata;
}

export interface ResolvedAgent {
  id: string;
  path: string;
  content: string;
}

export interface ResolvedSkill {
  name: string;
  path: string;
  content: string;
}

export interface ResolvedPlugin {
  plugin: LoadedPlugin;
  commands: ResolvedCommand[];
  agents: ResolvedAgent[];
  skills: ResolvedSkill[];
  hooks: HooksSettings | null;
}

export interface PluginLoadError {
  readonly pluginId?: PluginId;
  readonly path: string;
  readonly stage: "discovery" | "manifest" | "registration" | "components";
  readonly code: string;
  readonly message: string;
  readonly recoveryHint: string;
}

export interface PluginLoadResult {
  plugins: LoadedPlugin[];
  errors: PluginLoadError[];
}

function pluginIdForSource(name: string, source: string): PluginId | undefined {
  if (isPluginId(source)) return source;
  const marketplace = source.trim() && !source.includes("/") ? source : "local";
  try {
    return createPluginId(name, marketplace);
  } catch {
    return undefined;
  }
}

function loadError(
  path: string,
  stage: PluginLoadError["stage"],
  code: string,
  message: string,
  pluginId?: PluginId,
): PluginLoadError {
  return {
    ...(pluginId === undefined ? {} : { pluginId }),
    path,
    stage,
    code,
    message,
    recoveryHint: "Fix the plugin manifest or remove the installation, then reload plugins.",
  };
}

class PluginManifestLoadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PluginManifestLoadError";
    this.code = code;
  }
}

function resolveManifestPath(pluginDir: string): string | null {
  const nested = join(pluginDir, ".claude-plugin", "plugin.json");
  if (isFile(nested)) return nested;
  const flat = join(pluginDir, "plugin.json");
  if (isFile(flat)) return flat;
  return null;
}

export function loadPluginFromDirectory(
  pluginDir: string,
  source: string,
  options?: { requireManifest?: boolean; reportErrors?: boolean },
): LoadedPlugin | null {
  const root = resolve(pluginDir);
  const manifestPath = resolveManifestPath(root);

  let manifest: PluginManifest;
  if (manifestPath === null) {
    if (options?.requireManifest) {
      if (options.reportErrors) {
        throw new PluginManifestLoadError("PLUGIN_MANIFEST_MISSING", "Plugin manifest is missing");
      }
      return null;
    }
    const hasImplicitLayout = [
      "commands",
      "agents",
      "skills",
      "hooks",
      "workflows",
      "output-styles",
      "themes",
      ".mcp.json",
    ].some((entry) => existsAt(join(root, entry)));
    const fallbackName = basename(root);
    if (!hasImplicitLayout || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fallbackName)) return null;
    manifest = { name: fallbackName };
  } else {
    let raw: unknown;
    try {
      raw = readJsonFile(manifestPath);
    } catch (error) {
      if (options?.reportErrors) {
        throw new PluginManifestLoadError(
          "PLUGIN_MANIFEST_UNREADABLE",
          error instanceof Error ? error.message : String(error),
        );
      }
      return null;
    }
    try {
      manifest = parseManifest(raw);
    } catch (error) {
      if (options?.reportErrors) {
        throw new PluginManifestLoadError(
          "PLUGIN_MANIFEST_INVALID",
          error instanceof Error ? error.message : String(error),
        );
      }
      return null;
    }
  }
  const commandsPath = join(root, "commands");
  const agentsPath = join(root, "agents");
  const skillsPath = join(root, "skills");
  const workflowsPath = join(root, "workflows");
  const outputStylesPath = join(root, "output-styles");
  const themesPath = join(root, "themes");
  const hooksDir = join(root, "hooks");

  const installation = findPluginInstallationByPath(root);
  const plugin: LoadedPlugin = {
    name: manifest.name,
    path: root,
    source: installation?.marketplace ?? source,
    manifest,
  };

  if (isDirectory(commandsPath)) {
    plugin.commandsPath = commandsPath;
  }

  if (isDirectory(agentsPath)) {
    plugin.agentsPath = agentsPath;
  }

  if (isDirectory(skillsPath)) {
    plugin.skillsPath = skillsPath;
  }

  if (isDirectory(workflowsPath)) {
    plugin.workflowsPath = workflowsPath;
  }

  if (isDirectory(outputStylesPath)) {
    plugin.outputStylesPath = outputStylesPath;
  }

  if (isDirectory(themesPath)) {
    plugin.themesPath = themesPath;
  }

  // A manifest may name directories outside the default layout. One it names
  // that is not there is dropped rather than carried as a path that will fail.
  const declaredStyles = manifestPaths(manifest.outputStyles, root);
  if (declaredStyles.length > 0) plugin.outputStylesPaths = declaredStyles;
  const declaredThemes = manifestPaths(manifest.experimental?.themes ?? manifest.themes, root);
  if (declaredThemes.length > 0) plugin.themesPaths = declaredThemes;

  const hooksConfig = loadHooks(manifest, hooksDir, root);
  if (hooksConfig !== null) {
    plugin.hooksConfig = hooksConfig;
  }

  return plugin;
}

/**
 * The paths a manifest field names, resolved against the plugin. A directory or a
 * single file both count — a plugin shipping one style should not have to make a
 * directory to hold it. Anything missing, or pointing outside the plugin, is
 * dropped rather than carried as a path that fails on use.
 */
function manifestPaths(spec: string | string[] | undefined, root: string): string[] {
  if (spec === undefined) return [];
  const declared = Array.isArray(spec) ? spec : [spec];
  return declared
    .map((entry) => resolve(root, entry))
    .filter((path) => path.startsWith(root) && (isDirectory(path) || isFile(path)));
}

export function resolvePluginComponents(plugin: LoadedPlugin): ResolvedPlugin {
  const root = resolve(plugin.path);
  const commandSpec = plugin.manifest.commands;
  const commandEntries =
    typeof commandSpec === "string" || Array.isArray(commandSpec)
      ? (Array.isArray(commandSpec) ? commandSpec : [commandSpec]).flatMap((path) =>
          collectMdPath(path, root),
        )
      : plugin.commandsPath
        ? collectMdFiles(plugin.commandsPath, root)
        : [];
  const commands: ResolvedCommand[] = commandEntries.map((entry) => ({
    name: entry.name,
    path: entry.path,
    content: entry.content,
  }));
  if (commandSpec && typeof commandSpec === "object" && !Array.isArray(commandSpec)) {
    for (const [name, metadata] of Object.entries(commandSpec)) {
      const existing = commands.find((command) => command.name === name);
      if (metadata.content !== undefined) {
        const inline = { name, path: root, content: metadata.content, metadata };
        if (existing) Object.assign(existing, inline);
        else commands.push(inline);
        continue;
      }
      if (metadata.source !== undefined) {
        const sourced = collectMdPath(metadata.source, root)[0];
        if (!sourced) continue;
        const command = { name, path: sourced.path, content: sourced.content, metadata };
        if (existing) Object.assign(existing, command);
        else commands.push(command);
        continue;
      }
      if (existing) existing.metadata = metadata;
    }
  }

  const agentSpecs = plugin.manifest.agents;
  const agentEntries = agentSpecs
    ? (Array.isArray(agentSpecs) ? agentSpecs : [agentSpecs]).flatMap((path) =>
        collectMdPath(path, root),
      )
    : plugin.agentsPath
      ? collectMdFiles(plugin.agentsPath, root)
      : [];
  const agents: ResolvedAgent[] = agentEntries.map((entry) => ({
    id: entry.name,
    path: entry.path,
    content: entry.content,
  }));

  const skillSpecs = plugin.manifest.skills;
  const skills = skillSpecs
    ? (Array.isArray(skillSpecs) ? skillSpecs : [skillSpecs]).flatMap((path) =>
        collectSkillPath(path, root),
      )
    : plugin.skillsPath
      ? collectSkillEntries(plugin.skillsPath, root)
      : [];

  const hooks: HooksSettings | null = plugin.hooksConfig ?? null;

  return { plugin, commands, agents, skills, hooks };
}

export interface PluginLoadOptions {
  readonly cwd?: string;
}

interface PluginCandidate {
  readonly pluginId: PluginId;
  readonly plugin: LoadedPlugin;
  readonly rank: number;
}

function candidateRank(scope: "user" | "project" | "local"): number {
  return scope === "local" ? 3 : scope === "project" ? 2 : 1;
}

function errorFromLoadFailure(path: string, error: unknown, pluginId?: PluginId): PluginLoadError {
  if (error instanceof PluginManifestLoadError) {
    return loadError(path, "manifest", error.code, error.message, pluginId);
  }
  return loadError(
    path,
    "discovery",
    "PLUGIN_LOAD_FAILED",
    error instanceof Error ? error.message : String(error),
    pluginId,
  );
}

export function loadPluginsFromDirectories(
  dirs: string[],
  options?: PluginLoadOptions,
): PluginLoadResult {
  const candidates = new Map<PluginId, PluginCandidate>();
  const errors: PluginLoadError[] = [];
  const currentProjectPath = canonicalProjectPath(options?.cwd ?? getTrackedCwd());
  const managedRoot = resolve(configRoot(), "plugins", "installed");

  function addCandidate(plugin: LoadedPlugin, rank: number, pluginId?: PluginId): void {
    const canonicalId = pluginId ?? pluginIdForSource(plugin.name, plugin.source);
    if (!canonicalId) {
      errors.push(
        loadError(plugin.path, "registration", "PLUGIN_ID_INVALID", "Plugin has no canonical id"),
      );
      return;
    }
    const previous = candidates.get(canonicalId);
    if (!previous || rank >= previous.rank) {
      candidates.set(canonicalId, { pluginId: canonicalId, plugin, rank });
    }
  }

  try {
    for (const installation of listPluginInstallations()) {
      if (
        installation.scope !== "user" &&
        (installation.projectPath === undefined || installation.projectPath !== currentProjectPath)
      ) {
        continue;
      }
      const installPath = resolve(installation.installPath);
      if (!isDirectory(installPath)) {
        errors.push(
          loadError(
            installPath,
            "discovery",
            "PLUGIN_PAYLOAD_MISSING",
            "Installed plugin payload is missing",
            installation.identity,
          ),
        );
        continue;
      }
      try {
        const loaded = loadPluginFromDirectory(installPath, installation.identity, {
          requireManifest: true,
          reportErrors: true,
        });
        const parsedPluginId = parsePluginId(installation.identity);
        if (loaded && parsedPluginId && loaded.manifest.name !== parsedPluginId.name) {
          errors.push(
            loadError(
              installPath,
              "manifest",
              "PLUGIN_IDENTITY_MISMATCH",
              `Managed plugin ${installation.identity} declares manifest name ${JSON.stringify(
                loaded.manifest.name,
              )}; expected ${JSON.stringify(parsedPluginId.name)}.`,
              installation.identity,
            ),
          );
          continue;
        }
        if (loaded) addCandidate(loaded, candidateRank(installation.scope), installation.identity);
      } catch (error) {
        errors.push(errorFromLoadFailure(installPath, error, installation.identity));
      }
    }
  } catch (error) {
    errors.push(
      loadError(
        join(configRoot(), "plugins", "installed_plugins.json"),
        "discovery",
        "PLUGIN_REGISTRY_INVALID",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  for (const dir of dirs) {
    const resolvedDir = resolve(dir);
    if (resolvedDir === managedRoot || !isDirectory(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (error) {
      errors.push(errorFromLoadFailure(dir, error));
      continue;
    }
    for (const entry of entries) {
      const pluginDir = join(dir, entry);
      if (!isDirectory(pluginDir)) continue;
      try {
        const loaded = loadPluginFromDirectory(pluginDir, dir, { reportErrors: true });
        if (loaded) addCandidate(loaded, 4);
      } catch (error) {
        errors.push(errorFromLoadFailure(pluginDir, error));
      }
    }
  }

  const plugins = [...candidates.values()]
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId))
    .map((candidate) => candidate.plugin);
  return { plugins, errors };
}
