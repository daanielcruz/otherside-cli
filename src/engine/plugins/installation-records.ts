import {
  createPluginId,
  type InstallationId,
  type PluginId,
  type PluginInstallScope,
} from "./identity.ts";

export type { InstallationId, PluginId, PluginInstallScope } from "./identity.ts";

export interface PluginInstallation {
  identity: PluginId;
  pluginId: PluginId;
  installationId: InstallationId;
  pluginName: string;
  marketplace: string;
  scope: PluginInstallScope;
  projectPath?: string;
  version: string;
  installPath: string;
  cachePath: string;
  installedAt: string;
  lastUpdated: string;
}

export interface InstalledPluginsFile {
  version: typeof CURRENT_FILE_VERSION;
  plugins: Record<string, PluginInstallation[]>;
}

export interface PluginInstallationInput {
  pluginName?: string;
  marketplace?: string;
  pluginId?: PluginId | string;
  identity?: PluginId | string;
  scope: PluginInstallScope;
  projectPath?: string;
  version?: string;
  installPath: string;
  cachePath?: string;
  installedAt?: string;
  lastUpdated?: string;
}

export interface RawInstalledPluginsFile {
  version?: unknown;
  plugins?: unknown;
}

export interface RawPluginInstallation {
  pluginName?: unknown;
  marketplace?: unknown;
  pluginId?: unknown;
  identity?: unknown;
  installationId?: unknown;
  scope?: unknown;
  projectPath?: unknown;
  version?: unknown;
  installPath?: unknown;
  cachePath?: unknown;
  installedAt?: unknown;
  lastUpdated?: unknown;
}

export interface PayloadRelocation {
  readonly source: string;
  readonly destination: string;
}

export interface FileReadState {
  readonly file: InstalledPluginsFile;
  readonly needsMigration: boolean;
  readonly relocations: readonly PayloadRelocation[];
}

export const CURRENT_FILE_VERSION = 3 as const;

export const EMPTY_FILE: InstalledPluginsFile = { version: CURRENT_FILE_VERSION, plugins: {} };
export const INSTALL_SCOPES = new Set<PluginInstallScope>(["user", "project", "local"]);

export class PluginMigrationError extends Error {
  readonly code = "PLUGIN_MIGRATION_FAILED";
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`Cannot migrate ${filePath}: ${message}`);
    this.name = "PluginMigrationError";
    this.filePath = filePath;
  }
}

export class PluginLookupError extends Error {
  readonly code: "PLUGIN_NOT_FOUND" | "PLUGIN_AMBIGUOUS";
  readonly target: string;
  readonly candidates: readonly PluginId[];

  constructor(
    code: "PLUGIN_NOT_FOUND" | "PLUGIN_AMBIGUOUS",
    target: string,
    candidates: readonly PluginId[] = [],
  ) {
    super(
      code === "PLUGIN_AMBIGUOUS"
        ? `Plugin "${target}" is ambiguous. Choose one: ${[...candidates].sort().join(", ")}`
        : `Plugin not found: ${target}`,
    );
    this.name = "PluginLookupError";
    this.code = code;
    this.target = target;
    this.candidates = candidates;
  }
}

export type PluginLookupResult =
  | { ok: true; installation: PluginInstallation; pluginId: PluginId }
  | {
      ok: false;
      code: "PLUGIN_NOT_FOUND" | "PLUGIN_AMBIGUOUS";
      target: string;
      candidates: readonly PluginId[];
    };

export function formatPluginLookupFailure(
  result: Extract<PluginLookupResult, { ok: false }>,
): string {
  if (result.code === "PLUGIN_AMBIGUOUS") {
    return `Plugin "${result.target}" is ambiguous. Choose one: ${[...result.candidates].sort().join(", ")}`;
  }
  return `Plugin not found: ${result.target}`;
}

export interface PluginLookupOptions {
  readonly cwd?: string;
  readonly scope?: PluginInstallScope;
}

export function qualifiedPluginName(pluginName: string, marketplace: string): PluginId {
  return createPluginId(pluginName, marketplace);
}
