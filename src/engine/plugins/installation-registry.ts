import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { withFileLockSync } from "@/kernel/std/fs/file-lock.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { atomicWriteFileSync } from "@/kernel/std/fs/secure-fs.ts";
import {
  createInstallationId,
  createPluginId,
  type InstallationId,
  isPluginId,
  type PluginId,
  parsePluginId,
} from "./identity.ts";
import {
  projectPathForInstallation,
  readCurrentFile,
  readFileUnlocked,
  readRawFile,
} from "./installation-manifest.ts";
import {
  applyRelocations,
  finishRelocations,
  restoreRegistryFile,
  rollbackRelocations,
} from "./installation-migrations.ts";
import {
  activeInstallPath,
  cachePathForPlugin,
  validateInstallPath,
} from "./installation-paths.ts";
import {
  CURRENT_FILE_VERSION,
  EMPTY_FILE,
  type InstalledPluginsFile,
  type PluginInstallation,
  type PluginInstallationInput,
} from "./installation-records.ts";

export function installedPluginsPath(): string {
  return join(configRoot(), "plugins", "installed_plugins.json");
}

function writeInstallationFile(path: string, file: InstalledPluginsFile): void {
  atomicWriteFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

function readInstallationFile(): InstalledPluginsFile {
  const path = installedPluginsPath();
  if (!existsSync(path)) return { ...EMPTY_FILE, plugins: {} };
  const raw = readRawFile(path);
  if (raw && raw.version === CURRENT_FILE_VERSION) return readCurrentFile(raw, path);
  mkdirSync(dirname(path), { recursive: true });
  return withFileLockSync(path, () => {
    const original = existsSync(path) ? readFileSync(path, "utf8") : null;
    const state = readFileUnlocked(path);
    if (!state.needsMigration) return state.file;
    const applied = applyRelocations(path, state.relocations);
    try {
      writeInstallationFile(path, state.file);
      finishRelocations(applied);
      return state.file;
    } catch (error) {
      rollbackRelocations(applied);
      restoreRegistryFile(path, original);
      throw error;
    }
  });
}

function updateInstallationFile(
  mutator: (file: InstalledPluginsFile) => void,
): InstalledPluginsFile {
  const path = installedPluginsPath();
  mkdirSync(dirname(path), { recursive: true });
  return withFileLockSync(path, () => {
    const raw = existsSync(path) ? readFileSync(path, "utf8") : null;
    const state = readFileUnlocked(path);
    const applied = state.needsMigration ? applyRelocations(path, state.relocations) : [];
    try {
      mutator(state.file);
      writeInstallationFile(path, state.file);
      finishRelocations(applied);
      return state.file;
    } catch (error) {
      rollbackRelocations(applied);
      restoreRegistryFile(path, raw);
      throw error;
    }
  });
}

export function listPluginInstallations(): PluginInstallation[] {
  return Object.values(readInstallationFile().plugins)
    .flat()
    .sort(
      (a, b) =>
        a.identity.localeCompare(b.identity) || a.installationId.localeCompare(b.installationId),
    );
}

export function recordPluginInstallation(entry: PluginInstallationInput): PluginInstallation {
  let saved: PluginInstallation | undefined;
  updateInstallationFile((file) => {
    const pluginId = pluginIdForInput(entry);
    const parsedPlugin = parsePluginId(pluginId);
    if (!parsedPlugin) throw new Error(`Invalid plugin id: ${pluginId}`);
    const projectPath = projectPathForInstallation(
      entry.scope,
      entry.projectPath,
      entry.installPath,
      installedPluginsPath(),
      pluginId,
    );
    const version = entry.version ?? "0.0.0";
    const expectedInstallPath = activeInstallPath(
      parsedPlugin.name,
      entry.scope,
      parsedPlugin.marketplace,
      version,
      projectPath,
    );
    const expectedCachePath = cachePathForPlugin(
      parsedPlugin.marketplace,
      parsedPlugin.name,
      version,
    );
    const cachePath = entry.cachePath ?? expectedCachePath;
    if (!isAbsolute(entry.installPath) || !isAbsolute(cachePath)) {
      throw new Error(`Installation paths for ${pluginId} must be absolute`);
    }
    validateInstallPath(
      entry.scope,
      entry.installPath,
      projectPath,
      installedPluginsPath(),
      pluginId,
    );
    if (resolve(entry.installPath) !== expectedInstallPath) {
      throw new Error(`installPath for ${pluginId} is not canonical`);
    }
    if (resolve(cachePath) !== expectedCachePath) {
      throw new Error(`cachePath for ${pluginId} is not canonical`);
    }
    const installationId = createInstallationId(pluginId, entry.scope, projectPath);
    const occupiedBy = Object.values(file.plugins)
      .flat()
      .find(
        (item) =>
          item.installPath === expectedInstallPath && item.installationId !== installationId,
      );
    if (occupiedBy) {
      throw new Error(`installPath is already used by ${occupiedBy.installationId}`);
    }
    const previous = file.plugins[pluginId]?.find((item) => item.installationId === installationId);
    const now = new Date().toISOString();
    saved = {
      identity: pluginId,
      pluginId,
      installationId,
      pluginName: parsedPlugin.name,
      marketplace: parsedPlugin.marketplace,
      scope: entry.scope,
      ...(projectPath === undefined ? {} : { projectPath }),
      version,
      installPath: resolve(entry.installPath),
      cachePath: resolve(cachePath),
      installedAt: previous?.installedAt ?? entry.installedAt ?? now,
      lastUpdated: entry.lastUpdated ?? now,
    };
    const others = (file.plugins[pluginId] ?? []).filter(
      (item) => item.installationId !== installationId,
    );
    file.plugins[pluginId] = [...others, saved];
  });
  if (!saved) throw new Error("Plugin installation was not recorded");
  return saved;
}

function pluginIdForInput(entry: PluginInstallationInput): PluginId {
  const explicit = entry.pluginId ?? entry.identity;
  if (explicit !== undefined) {
    if (!isPluginId(explicit)) throw new Error(`Invalid plugin id: ${explicit}`);
    if (entry.pluginName !== undefined && entry.marketplace !== undefined) {
      const fromParts = createPluginId(entry.pluginName, entry.marketplace);
      if (fromParts !== explicit) throw new Error("Plugin identity fields disagree");
    }
    return explicit;
  }
  if (entry.pluginName === undefined || entry.marketplace === undefined) {
    throw new Error("Plugin name and marketplace are required");
  }
  return createPluginId(entry.pluginName, entry.marketplace);
}

export function removePluginInstallationById(
  installationId: InstallationId,
): PluginInstallation | undefined {
  const found = listPluginInstallations().find((entry) => entry.installationId === installationId);
  if (!found) return undefined;
  updateInstallationFile((file) => {
    const remaining = (file.plugins[found.identity] ?? []).filter(
      (item) => item.installationId !== installationId,
    );
    if (remaining.length === 0) delete file.plugins[found.identity];
    else file.plugins[found.identity] = remaining;
  });
  return found;
}

export function restorePluginInstallation(
  installationId: InstallationId,
  previous: PluginInstallation | undefined,
): void {
  updateInstallationFile((file) => {
    const entries = (file.plugins[previous?.identity ?? ""] ?? []).filter(
      (item) => item.installationId !== installationId,
    );
    if (previous) {
      const restored = [...entries, previous].sort((left, right) =>
        left.installationId.localeCompare(right.installationId),
      );
      file.plugins[previous.identity] = restored;
    } else if (entries.length === 0) {
      for (const [pluginId, pluginEntries] of Object.entries(file.plugins)) {
        const remaining = pluginEntries.filter((item) => item.installationId !== installationId);
        if (remaining.length === 0) delete file.plugins[pluginId];
        else if (remaining.length !== pluginEntries.length) file.plugins[pluginId] = remaining;
      }
    }
  });
}
