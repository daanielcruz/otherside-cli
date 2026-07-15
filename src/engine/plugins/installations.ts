import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { withFileLockSync } from "@/kernel/std/fs/file-lock.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { atomicWriteFileSync } from "@/kernel/std/fs/secure-fs.ts";

export type PluginInstallScope = "user" | "project" | "local";

export interface PluginInstallation {
  identity: string;
  pluginName: string;
  marketplace: string;
  scope: PluginInstallScope;
  version: string;
  installPath: string;
  cachePath: string;
  installedAt: string;
  lastUpdated: string;
}

interface InstalledPluginsFile {
  version: 2;
  plugins: Record<string, PluginInstallation[]>;
}

const EMPTY_FILE: InstalledPluginsFile = { version: 2, plugins: {} };

export function qualifiedPluginName(pluginName: string, marketplace: string): string {
  return `${pluginName}@${marketplace}`;
}

export function installedPluginsPath(): string {
  return join(configRoot(), "plugins", "installed_plugins.json");
}

function readFile(): InstalledPluginsFile {
  const path = installedPluginsPath();
  if (!existsSync(path)) return { ...EMPTY_FILE, plugins: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<InstalledPluginsFile>;
    if (!parsed.plugins || typeof parsed.plugins !== "object")
      return { ...EMPTY_FILE, plugins: {} };
    return { version: 2, plugins: parsed.plugins };
  } catch {
    return { ...EMPTY_FILE, plugins: {} };
  }
}

function updateFile(mutator: (file: InstalledPluginsFile) => void): InstalledPluginsFile {
  const path = installedPluginsPath();
  mkdirSync(dirname(path), { recursive: true });
  return withFileLockSync(path, () => {
    const file = readFile();
    mutator(file);
    atomicWriteFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
    return file;
  });
}

export function listPluginInstallations(): PluginInstallation[] {
  return Object.values(readFile().plugins)
    .flat()
    .sort((a, b) => a.identity.localeCompare(b.identity) || a.scope.localeCompare(b.scope));
}

export function findPluginInstallation(target: string): PluginInstallation | undefined {
  const installations = listPluginInstallations();
  if (target.includes("@")) return installations.find((entry) => entry.identity === target);
  const matches = installations.filter((entry) => entry.pluginName === target);
  return matches.length === 1 ? matches[0] : undefined;
}

export function findPluginInstallationByPath(path: string): PluginInstallation | undefined {
  const resolved = resolve(path);
  return listPluginInstallations().find((entry) => resolve(entry.installPath) === resolved);
}

export function pluginIdentity(pluginName: string): string {
  return findPluginInstallation(pluginName)?.identity ?? pluginName;
}

export function recordPluginInstallation(
  entry: Omit<PluginInstallation, "identity" | "installedAt" | "lastUpdated"> & {
    installedAt?: string;
  },
): PluginInstallation {
  const now = new Date().toISOString();
  const identity = qualifiedPluginName(entry.pluginName, entry.marketplace);
  const previous = readFile().plugins[identity]?.find((item) => item.scope === entry.scope);
  const installation: PluginInstallation = {
    ...entry,
    identity,
    installedAt: previous?.installedAt ?? entry.installedAt ?? now,
    lastUpdated: now,
  };
  updateFile((file) => {
    const others = (file.plugins[identity] ?? []).filter((item) => item.scope !== entry.scope);
    file.plugins[identity] = [...others, installation];
  });
  return installation;
}

export function forgetPluginInstallation(target: string): PluginInstallation | undefined {
  const found = findPluginInstallation(target);
  if (!found) return undefined;
  updateFile((file) => {
    const remaining = (file.plugins[found.identity] ?? []).filter(
      (item) => item.scope !== found.scope,
    );
    if (remaining.length === 0) delete file.plugins[found.identity];
    else file.plugins[found.identity] = remaining;
  });
  return found;
}

export function activeInstallPath(pluginName: string, scope: PluginInstallScope): string {
  if (scope === "user") return join(configRoot(), "plugins", "installed", pluginName);
  const directory = scope === "project" ? "installed" : "installed-local";
  return join(process.cwd(), ".otherside", "plugins", directory, pluginName);
}

export function cachePathForPlugin(
  marketplace: string,
  pluginName: string,
  version: string,
): string {
  return join(configRoot(), "plugins", "cache", marketplace, pluginName, version);
}
