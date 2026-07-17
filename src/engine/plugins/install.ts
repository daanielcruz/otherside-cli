import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadConfigSync, updateConfig } from "@/kernel/config/config.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { getTrackedCwd } from "@/kernel/std/state/cwd-state.ts";
import { normalizeProjectPath } from "./identity.ts";
import {
  activeInstallPath,
  cachePathForPlugin,
  formatPluginLookupFailure,
  listPluginInstallations,
  lookupPluginInstallation,
  type PluginInstallScope,
  recordPluginInstallation,
  removePluginInstallationById,
  restorePluginInstallation,
} from "./installations.ts";
import { loadPluginFromDirectory } from "./loader.ts";
import { clearPluginPayloadOrphanMarker, markRemovedInstallationPayloads } from "./prune.ts";
import {
  clearEnabledSetting,
  replaceSnapshot as replacePluginRegistrySnapshot,
  snapshot as snapshotPluginRegistry,
} from "./registry.ts";
import {
  beginInstallation,
  finishInstallation,
  getSnapshot,
  replaceDiskState,
  replaceSnapshot,
  updateInstallation,
} from "./state.ts";

export interface InstallResult {
  success: boolean;
  message: string;
  pluginName?: string;
  identity?: string;
  version?: string;
}

export function getPluginsDir(): string {
  const dir = join(configRoot(), "plugins", "installed");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function installPayload(
  sourceDir: string,
  pluginName: string,
  marketplace: string,
  version: string,
  scope: PluginInstallScope,
  cwd: string,
): InstallResult {
  const projectPath = scope === "user" ? undefined : normalizeProjectPath(cwd);
  const cachePath = cachePathForPlugin(marketplace, pluginName, version);
  const destination = activeInstallPath(pluginName, scope, marketplace, version, projectPath);
  const pluginId = `${pluginName}@${marketplace}`;
  const installationTarget = { type: "plugin" as const, id: pluginId, name: pluginName };
  const stateBefore = getSnapshot();
  beginInstallation(installationTarget);
  updateInstallation({ ...installationTarget, status: "installing" });
  const complete = (result: InstallResult): InstallResult => {
    if (!result.success) {
      replaceSnapshot(stateBefore);
      return result;
    }
    finishInstallation({ ...installationTarget, status: "installed" });
    replaceDiskState({ installations: listPluginInstallations() });
    return result;
  };
  const previous = listPluginInstallations().find(
    (entry) =>
      entry.identity === pluginId &&
      entry.scope === scope &&
      (scope === "user" || entry.projectPath === projectPath),
  );
  if (previous) {
    return complete({
      success: false,
      message: `Plugin '${pluginId}' is already installed. Use '/plugin' to manage existing plugins.`,
    });
  }
  mkdirSync(dirname(destination), { recursive: true });
  const stagingRoot = mkdtempSync(join(dirname(destination), ".plugin-install-"));
  const staged = join(stagingRoot, "payload");
  const backup = join(stagingRoot, "previous");
  let cacheCreated = false;
  let swapped = false;
  let installation: ReturnType<typeof recordPluginInstallation> | undefined;
  try {
    if (!existsSync(cachePath)) {
      mkdirSync(dirname(cachePath), { recursive: true });
      cpSync(sourceDir, cachePath, { recursive: true });
      cacheCreated = true;
    }
    cpSync(cachePath, staged, { recursive: true });
    if (existsSync(destination)) renameSync(destination, backup);
    renameSync(staged, destination);
    swapped = true;
    const loaded = loadPluginFromDirectory(destination, pluginId, {
      requireManifest: true,
      reportErrors: true,
    });
    if (!loaded) throw new Error("installed plugin could not be loaded");
    installation = recordPluginInstallation({
      pluginId,
      scope,
      ...(projectPath === undefined ? {} : { projectPath }),
      version,
      installPath: destination,
      cachePath,
    });
    // A reused cache dir may still carry the orphan stamp from a previous
    // final-scope uninstall (and the copy above propagates it into the new
    // payload); both directories are referenced again now.
    clearPluginPayloadOrphanMarker(cachePath);
    clearPluginPayloadOrphanMarker(destination);
    const result = complete({
      success: true,
      message: `Installed ${installation.identity}. Run /reload to apply.`,
      pluginName,
      identity: installation.identity,
      version,
    });
    if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
    return result;
  } catch (error) {
    if (swapped && existsSync(destination)) rmSync(destination, { recursive: true, force: true });
    if (existsSync(backup)) {
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(backup, destination);
    }
    if (cacheCreated) rmSync(cachePath, { recursive: true, force: true });
    if (installation) restorePluginInstallation(installation.installationId, previous);
    return complete({
      success: false,
      message: `Failed to copy plugin: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

export function installPlugin(
  source: string,
  options?: { scope?: PluginInstallScope; cwd?: string },
): InstallResult {
  const scope = options?.scope ?? "user";
  const cwd = options?.cwd ?? getTrackedCwd();
  const pluginsDir = getPluginsDir();

  // Try to treat as local directory
  let sourceDir = source;
  if (!isAbsolute(sourceDir) && !sourceDir.startsWith("github:") && !sourceDir.startsWith("http")) {
    sourceDir = resolve(cwd, source);
  }

  if (existsSync(sourceDir)) {
    const testLoad = loadPluginFromDirectory(sourceDir, sourceDir);
    if (!testLoad) {
      return { success: false, message: `Invalid plugin directory` };
    }

    const pluginName = testLoad.name;
    return installPayload(
      sourceDir,
      pluginName,
      "local",
      testLoad.manifest.version || "0.0.0",
      scope,
      cwd,
    );
  }

  // Fallback to github clone if it looks like user/repo
  const githubPattern = /^(?:github:)?([a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)$/;
  const match = source.match(githubPattern);
  if (match) {
    const repo = match[1];
    const tempDir = join(pluginsDir, `.tmp-${Date.now()}`);
    try {
      execSync(`git clone https://github.com/${repo}.git "${tempDir}"`, { stdio: "ignore" });

      const testLoad = loadPluginFromDirectory(tempDir, source);
      if (!testLoad) {
        rmSync(tempDir, { recursive: true, force: true });
        return { success: false, message: `Repository is not a valid plugin` };
      }

      const result = installPayload(
        tempDir,
        testLoad.name,
        "github",
        testLoad.manifest.version || "0.0.0",
        scope,
        cwd,
      );
      rmSync(tempDir, { recursive: true, force: true });
      return result;
    } catch (e) {
      if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
      return {
        success: false,
        message: `Failed to clone repository: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  return { success: false, message: `Unrecognized plugin source or path not found: ${source}` };
}

export async function removePlugin(target: string): Promise<InstallResult> {
  const lookup = lookupPluginInstallation(target);
  if (!lookup.ok) {
    return { success: false, message: formatPluginLookupFailure(lookup) };
  }
  const installation = lookup.installation;
  if (!existsSync(installation.installPath)) {
    return { success: false, message: `Plugin installation ${target} is not installed.` };
  }
  const pluginName = installation.pluginName;
  const stateBefore = getSnapshot();
  const registryBefore = snapshotPluginRegistry();
  const configBefore = loadConfigSync();
  let configUpdated = false;
  let removed: ReturnType<typeof removePluginInstallationById> | undefined;
  try {
    await clearEnabledSetting(installation.identity);
    configUpdated = true;
    removed = removePluginInstallationById(installation.installationId);
    if (!removed) throw new Error("plugin installation metadata could not be removed");
    replaceDiskState({ installations: listPluginInstallations() });
    // The payload directories are not deleted here: they get an orphan marker
    // (shared cache only once the last scope is gone) and the startup sweep
    // removes them after the retention window (prune.ts).
    markRemovedInstallationPayloads(removed);
    return {
      success: true,
      message: `Uninstalled plugin ${installation.identity}.`,
      pluginName,
      identity: installation.identity,
      version: installation.version,
    };
  } catch (e) {
    if (removed) restorePluginInstallation(removed.installationId, removed);
    if (configUpdated) {
      try {
        await updateConfig((cfg) => {
          if (configBefore.enabledPlugins === undefined) delete cfg.enabledPlugins;
          else cfg.enabledPlugins = { ...configBefore.enabledPlugins };
        });
      } catch {}
    }
    replacePluginRegistrySnapshot(registryBefore);
    replaceSnapshot(stateBefore);
    return {
      success: false,
      message: `Failed to uninstall plugin: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
