import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  canonicalProjectPath,
  createInstallationId,
  createPluginId,
  isPluginId,
  type PluginId,
  type PluginInstallScope,
  parsePluginId,
} from "./identity.ts";
import {
  activeInstallPath,
  cachePathForPlugin,
  isWithinRoot,
  pluginCacheRoot,
  projectPathFromInstallPath,
  validateInstallPath,
} from "./installation-paths.ts";
import {
  CURRENT_FILE_VERSION,
  EMPTY_FILE,
  type FileReadState,
  INSTALL_SCOPES,
  type InstalledPluginsFile,
  type PayloadRelocation,
  type PluginInstallation,
  PluginMigrationError,
  type RawInstalledPluginsFile,
  type RawPluginInstallation,
} from "./installation-records.ts";

function asRawFile(value: unknown, path: string): RawInstalledPluginsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginMigrationError(path, "root must be an object");
  }
  return value as RawInstalledPluginsFile;
}

export function readRawFile(path: string): RawInstalledPluginsFile | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new PluginMigrationError(
      path,
      `JSON is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return asRawFile(parsed, path);
}

export function readCurrentFile(raw: RawInstalledPluginsFile, path: string): InstalledPluginsFile {
  if (!raw.plugins || typeof raw.plugins !== "object" || Array.isArray(raw.plugins)) {
    throw new PluginMigrationError(path, "current schema has no plugin map");
  }
  const plugins: Record<string, PluginInstallation[]> = {};
  const installationIds = new Set<string>();
  const installPaths = new Set<string>();
  for (const [pluginId, rawEntries] of Object.entries(raw.plugins)) {
    if (!isPluginId(pluginId)) {
      throw new PluginMigrationError(
        path,
        `current schema has a non-canonical plugin key ${pluginId}`,
      );
    }
    if (!Array.isArray(rawEntries)) {
      throw new PluginMigrationError(path, `current schema entry ${pluginId} is not an array`);
    }
    plugins[pluginId] = rawEntries.map((entry) => {
      const installation = normalizeInstallation(pluginId, entry, path, false);
      if (installationIds.has(installation.installationId)) {
        throw new PluginMigrationError(
          path,
          `duplicate installation id ${installation.installationId}`,
        );
      }
      installationIds.add(installation.installationId);
      if (installPaths.has(installation.installPath)) {
        throw new PluginMigrationError(
          path,
          `multiple installations target ${installation.installPath}`,
        );
      }
      installPaths.add(installation.installPath);
      return installation;
    });
  }
  return { version: CURRENT_FILE_VERSION, plugins };
}

function migrateFile(
  raw: RawInstalledPluginsFile,
  path: string,
): {
  file: InstalledPluginsFile;
  relocations: readonly PayloadRelocation[];
} {
  if (!raw.plugins || typeof raw.plugins !== "object" || Array.isArray(raw.plugins)) {
    throw new PluginMigrationError(path, "legacy schema has no plugin map");
  }
  const migrated: Record<string, PluginInstallation[]> = {};
  const installationIds = new Set<string>();
  const destinationPaths = new Set<string>();
  const relocationSources = new Map<string, string>();
  const relocations: PayloadRelocation[] = [];
  const queueRelocation = (source: string, destination: string): void => {
    const normalizedSource = resolve(source);
    const normalizedDestination = resolve(destination);
    const previousSource = relocationSources.get(normalizedDestination);
    if (previousSource !== undefined) {
      if (previousSource !== normalizedSource) {
        throw new PluginMigrationError(path, `multiple payloads target ${normalizedDestination}`);
      }
      return;
    }
    relocationSources.set(normalizedDestination, normalizedSource);
    relocations.push({ source: normalizedSource, destination: normalizedDestination });
  };
  for (const [rawKey, rawValue] of Object.entries(raw.plugins)) {
    const entries = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const entry of entries) {
      const normalized = normalizeInstallation(rawKey, entry, path, true);
      if (installationIds.has(normalized.installationId)) {
        throw new PluginMigrationError(
          path,
          `duplicate installation id ${normalized.installationId}`,
        );
      }
      installationIds.add(normalized.installationId);
      if (destinationPaths.has(normalized.installPath)) {
        throw new PluginMigrationError(
          path,
          `multiple installations target ${normalized.installPath}`,
        );
      }
      destinationPaths.add(normalized.installPath);
      const current = migrated[normalized.identity] ?? [];
      migrated[normalized.identity] = [...current, normalized];

      const legacyPath = rawInstallPath(entry);
      if (legacyPath && resolve(legacyPath) !== normalized.installPath) {
        if (existsSync(normalized.installPath)) {
          throw new PluginMigrationError(
            path,
            `migration destination already exists: ${normalized.installPath}`,
          );
        }
        if (existsSync(legacyPath)) {
          queueRelocation(legacyPath, normalized.installPath);
        }
      }
      const legacyCachePath = rawCachePath(entry);
      if (legacyCachePath && resolve(legacyCachePath) !== normalized.cachePath) {
        if (existsSync(normalized.cachePath)) {
          throw new PluginMigrationError(
            path,
            `migration cache destination already exists: ${normalized.cachePath}`,
          );
        }
        if (existsSync(legacyCachePath)) {
          queueRelocation(legacyCachePath, normalized.cachePath);
        }
      }
    }
  }
  return { file: { version: CURRENT_FILE_VERSION, plugins: migrated }, relocations };
}

function normalizeInstallation(
  rawKey: string,
  value: unknown,
  path: string,
  migrate: boolean,
): PluginInstallation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginMigrationError(path, `installation for ${rawKey} is not an object`);
  }
  const raw = value as RawPluginInstallation;
  const pluginId = pluginIdFromRaw(rawKey, raw, path);
  const parsedPlugin = parsePluginId(pluginId);
  if (!parsedPlugin) throw new PluginMigrationError(path, `invalid plugin id ${pluginId}`);

  const scope = scopeFromRaw(raw.scope, path, rawKey);
  if (!migrate && (typeof raw.pluginName !== "string" || typeof raw.marketplace !== "string")) {
    throw new PluginMigrationError(path, `name and marketplace for ${rawKey} are missing`);
  }
  if (!migrate && raw.scope === undefined) {
    throw new PluginMigrationError(path, `scope for ${rawKey} is missing`);
  }
  if (!migrate && raw.pluginId !== pluginId) {
    throw new PluginMigrationError(path, `pluginId for ${rawKey} is not canonical`);
  }
  if (!migrate && raw.identity !== pluginId) {
    throw new PluginMigrationError(path, `identity for ${rawKey} is not canonical`);
  }
  const installPath = stringField(raw.installPath, "installPath", path, rawKey);
  if (!isAbsolute(installPath)) {
    throw new PluginMigrationError(path, `installPath for ${rawKey} must be absolute`);
  }
  const projectPath = projectPathForInstallation(scope, raw.projectPath, installPath, path, rawKey);
  if (!migrate && scope !== "user" && typeof raw.projectPath !== "string") {
    throw new PluginMigrationError(path, `projectPath for ${rawKey} is missing`);
  }
  const version = migrate
    ? stringOrDefault(raw.version, "0.0.0")
    : stringField(raw.version, "version", path, rawKey);
  if (!migrate && raw.cachePath === undefined) {
    throw new PluginMigrationError(path, `cachePath for ${rawKey} is missing`);
  }
  const cachePath = cachePathForRaw(raw.cachePath, parsedPlugin, version, path, rawKey, migrate);
  const installedAt = migrate
    ? stringOrDefault(raw.installedAt, new Date().toISOString())
    : stringField(raw.installedAt, "installedAt", path, rawKey);
  const lastUpdated = migrate
    ? stringOrDefault(raw.lastUpdated, installedAt)
    : stringField(raw.lastUpdated, "lastUpdated", path, rawKey);
  validateInstallPath(scope, installPath, projectPath, path, rawKey);
  const expectedInstallPath = activeInstallPath(
    parsedPlugin.name,
    scope,
    parsedPlugin.marketplace,
    version,
    projectPath,
  );
  validateInstallPath(scope, expectedInstallPath, projectPath, path, rawKey);
  const installationId = createInstallationId(pluginId, scope, projectPath);
  if (!migrate && raw.installationId === undefined) {
    throw new PluginMigrationError(path, `installationId for ${rawKey} is missing`);
  }
  if (raw.installationId !== undefined) {
    if (typeof raw.installationId !== "string" || raw.installationId !== installationId) {
      throw new PluginMigrationError(
        path,
        `installation id for ${rawKey} does not match its fields`,
      );
    }
  }
  if (!migrate && resolve(installPath) !== expectedInstallPath) {
    throw new PluginMigrationError(path, `installPath for ${rawKey} is not canonical`);
  }

  return {
    identity: pluginId,
    pluginId,
    installationId,
    pluginName: parsedPlugin.name,
    marketplace: parsedPlugin.marketplace,
    scope,
    ...(projectPath === undefined ? {} : { projectPath }),
    version,
    installPath: expectedInstallPath,
    cachePath,
    installedAt,
    lastUpdated,
  };
}

function pluginIdFromRaw(rawKey: string, raw: RawPluginInstallation, path: string): PluginId {
  const keyId = parsePluginId(rawKey) ? (rawKey as PluginId) : undefined;
  const rawIds = [raw.pluginId, raw.identity].filter((value) => value !== undefined);
  for (const rawId of rawIds) {
    if (typeof rawId !== "string" || !isPluginId(rawId)) {
      throw new PluginMigrationError(
        path,
        `installation for ${rawKey} has a non-canonical plugin id`,
      );
    }
  }
  const explicitId = rawIds[0] as PluginId | undefined;
  if (explicitId !== undefined && rawIds[1] !== undefined && rawIds[1] !== explicitId) {
    throw new PluginMigrationError(path, `installation for ${rawKey} has conflicting plugin ids`);
  }
  if (keyId && explicitId && keyId !== explicitId) {
    throw new PluginMigrationError(path, `plugin key ${rawKey} conflicts with its identity`);
  }
  let partsId: PluginId | undefined;
  if (raw.pluginName !== undefined || raw.marketplace !== undefined) {
    if (typeof raw.pluginName !== "string" || typeof raw.marketplace !== "string") {
      throw new PluginMigrationError(
        path,
        `installation for ${rawKey} has incomplete identity fields`,
      );
    }
    try {
      partsId = createPluginId(raw.pluginName, raw.marketplace);
    } catch (error) {
      throw new PluginMigrationError(path, error instanceof Error ? error.message : String(error));
    }
  }
  if (explicitId && partsId && explicitId !== partsId) {
    throw new PluginMigrationError(
      path,
      `installation for ${rawKey} has conflicting identity fields`,
    );
  }
  if (keyId && partsId && keyId !== partsId) {
    throw new PluginMigrationError(path, `plugin key ${rawKey} conflicts with its identity fields`);
  }
  if (keyId) return keyId;
  if (explicitId) return explicitId;
  if (partsId) return partsId;
  throw new PluginMigrationError(
    path,
    `cannot derive canonical plugin id for ${rawKey}; marketplace is required`,
  );
}

function rawInstallPath(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as RawPluginInstallation;
  return typeof raw.installPath === "string" && isAbsolute(raw.installPath)
    ? raw.installPath
    : undefined;
}

function rawCachePath(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as RawPluginInstallation;
  return typeof raw.cachePath === "string" && isAbsolute(raw.cachePath) ? raw.cachePath : undefined;
}

function scopeFromRaw(value: unknown, path: string, pluginId: string): PluginInstallScope {
  if (value === undefined) return "user";
  if (typeof value === "string" && INSTALL_SCOPES.has(value as PluginInstallScope)) {
    return value as PluginInstallScope;
  }
  throw new PluginMigrationError(path, `invalid installation scope for ${pluginId}`);
}

export function projectPathForInstallation(
  scope: PluginInstallScope,
  rawProjectPath: unknown,
  installPath: string,
  path: string,
  pluginId: string,
): string | undefined {
  if (scope === "user") {
    if (rawProjectPath !== undefined) {
      throw new PluginMigrationError(
        path,
        `user installation ${pluginId} cannot have a projectPath`,
      );
    }
    return undefined;
  }
  if (rawProjectPath !== undefined && typeof rawProjectPath !== "string") {
    throw new PluginMigrationError(path, `invalid projectPath for ${pluginId}`);
  }
  if (rawProjectPath !== undefined) {
    try {
      const normalized = canonicalProjectPath(rawProjectPath as string);
      if (normalized === undefined) throw new Error("projectPath is empty");
      return normalized;
    } catch (error) {
      throw new PluginMigrationError(path, `invalid projectPath for ${pluginId}: ${String(error)}`);
    }
  }
  const inferred = projectPathFromInstallPath(installPath, scope);
  if (inferred === undefined) {
    throw new PluginMigrationError(
      path,
      `cannot infer projectPath for ${pluginId} from a confined .otherside/plugins/${
        scope === "project" ? "installed" : "installed-local"
      } path`,
    );
  }
  return inferred;
}

function cachePathForRaw(
  value: unknown,
  plugin: { name: string; marketplace: string },
  version: string,
  path: string,
  pluginId: string,
  migrate: boolean,
): string {
  const expected = cachePathForPlugin(plugin.marketplace, plugin.name, version);
  const cachePath = value === undefined ? expected : value;
  if (typeof cachePath !== "string" || !isAbsolute(cachePath)) {
    throw new PluginMigrationError(path, `invalid cachePath for ${pluginId}`);
  }
  const resolved = resolve(cachePath);
  if (!isWithinRoot(pluginCacheRoot(), resolved)) {
    throw new PluginMigrationError(
      path,
      `cachePath for ${pluginId} escapes the configured cache root`,
    );
  }
  if (resolved !== expected && !migrate) {
    throw new PluginMigrationError(path, `cachePath for ${pluginId} is not canonical`);
  }
  return migrate ? expected : resolved;
}

function stringField(value: unknown, field: string, path: string, pluginId: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PluginMigrationError(path, `${field} for ${pluginId} is missing`);
  }
  return value;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function readFileUnlocked(path: string): FileReadState {
  const raw = readRawFile(path);
  if (raw === null) {
    return { file: { ...EMPTY_FILE, plugins: {} }, needsMigration: false, relocations: [] };
  }
  const version = raw.version === undefined ? 1 : raw.version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new PluginMigrationError(path, `unsupported schema version ${String(version)}`);
  }
  if (version === CURRENT_FILE_VERSION) {
    return { file: readCurrentFile(raw, path), needsMigration: false, relocations: [] };
  }
  if (version !== 1 && version !== 2) {
    throw new PluginMigrationError(path, `unsupported schema version ${String(version)}`);
  }
  const migration = migrateFile(raw, path);
  return { ...migration, needsMigration: true };
}
