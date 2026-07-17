import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { withFileLockSync } from "@/kernel/std/fs/file-lock.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { atomicWriteFileSync } from "@/kernel/std/fs/secure-fs.ts";
import { getTrackedCwd } from "@/kernel/std/state/cwd-state.ts";
import {
  createInstallationId,
  createPluginId,
  type InstallationId,
  isPluginId,
  normalizeProjectPath,
  type PluginId,
  type PluginInstallScope,
  parseInstallationId,
  parsePluginId,
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

interface InstalledPluginsFile {
  version: typeof CURRENT_FILE_VERSION;
  plugins: Record<string, PluginInstallation[]>;
}

interface PluginInstallationInput {
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

interface RawInstalledPluginsFile {
  version?: unknown;
  plugins?: unknown;
}

interface RawPluginInstallation {
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

interface PayloadRelocation {
  readonly source: string;
  readonly destination: string;
}

interface FileReadState {
  readonly file: InstalledPluginsFile;
  readonly needsMigration: boolean;
  readonly relocations: readonly PayloadRelocation[];
}

export const CURRENT_FILE_VERSION = 3 as const;

const EMPTY_FILE: InstalledPluginsFile = { version: CURRENT_FILE_VERSION, plugins: {} };
const INSTALL_SCOPES = new Set<PluginInstallScope>(["user", "project", "local"]);

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

export function installedPluginsPath(): string {
  return join(configRoot(), "plugins", "installed_plugins.json");
}

function asRawFile(value: unknown, path: string): RawInstalledPluginsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginMigrationError(path, "root must be an object");
  }
  return value as RawInstalledPluginsFile;
}

function readRawFile(path: string): RawInstalledPluginsFile | null {
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

function isCurrentFile(raw: RawInstalledPluginsFile): boolean {
  return raw.version === CURRENT_FILE_VERSION;
}

function readCurrentFile(raw: RawInstalledPluginsFile, path: string): InstalledPluginsFile {
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

function projectPathForInstallation(
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
      const normalized = normalizeProjectPath(rawProjectPath as string);
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
  if (!isWithinRoot(cacheRoot(), resolved)) {
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

function validateInstallPath(
  scope: PluginInstallScope,
  installPath: string,
  projectPath: string | undefined,
  path: string,
  pluginId: string,
): void {
  const resolved = resolve(installPath);
  const roots =
    scope === "user"
      ? [join(configRoot(), "plugins", "installed")]
      : projectPath === undefined
        ? []
        : [
            join(
              projectPath,
              ".otherside",
              "plugins",
              scope === "project" ? "installed" : "installed-local",
            ),
          ];
  if (!roots.some((root) => isWithinRoot(root, resolved) && resolve(root) !== resolved)) {
    throw new PluginMigrationError(
      path,
      `installPath for ${pluginId} is outside its configured root`,
    );
  }
}

function canonicalPath(path: string): string {
  const missing: string[] = [];
  let candidate = resolve(path);
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) break;
    missing.unshift(candidate.slice(parent.length + 1));
    candidate = parent;
  }
  let canonical: string;
  try {
    canonical = realpathSync(candidate);
  } catch {
    canonical = candidate;
  }
  return missing.reduce((current, segment) => resolve(current, segment), canonical);
}

function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(canonicalPath(root), canonicalPath(target));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isWithinLexicalRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
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

function readFileUnlocked(): FileReadState {
  const path = installedPluginsPath();
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

function writeFile(path: string, file: InstalledPluginsFile): void {
  atomicWriteFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

function validateMigrationRelocations(relocations: readonly PayloadRelocation[]): void {
  const destinations = new Set<string>();
  for (const relocation of relocations) {
    if (destinations.has(relocation.destination)) {
      throw new PluginMigrationError(
        installedPluginsPath(),
        `multiple payloads target ${relocation.destination}`,
      );
    }
    destinations.add(relocation.destination);
    if (existsSync(relocation.destination)) {
      throw new PluginMigrationError(
        installedPluginsPath(),
        `migration destination already exists: ${relocation.destination}`,
      );
    }
  }
}

interface AppliedRelocation {
  readonly relocation: PayloadRelocation;
  readonly stagingPath: string;
  applied: boolean;
}

function applyRelocations(relocations: readonly PayloadRelocation[]): AppliedRelocation[] {
  validateMigrationRelocations(relocations);
  const applied: AppliedRelocation[] = [];
  try {
    for (const relocation of relocations) {
      mkdirSync(dirname(relocation.destination), { recursive: true });
      const stagingPath = mkdtempSync(join(dirname(relocation.destination), ".plugin-migration-"));
      const appliedRelocation: AppliedRelocation = { relocation, stagingPath, applied: false };
      applied.push(appliedRelocation);
      const stagedPayload = join(stagingPath, "payload");
      cpSync(relocation.source, stagedPayload, { recursive: true });
      renameSync(stagedPayload, relocation.destination);
      appliedRelocation.applied = true;
    }
    return applied;
  } catch (error) {
    rollbackRelocations(applied);
    throw error;
  }
}

function rollbackRelocations(applied: readonly AppliedRelocation[]): void {
  for (const entry of [...applied].reverse()) {
    if (entry.applied) {
      if (!existsSync(entry.relocation.source) && existsSync(entry.relocation.destination)) {
        mkdirSync(dirname(entry.relocation.source), { recursive: true });
        cpSync(entry.relocation.destination, entry.relocation.source, { recursive: true });
      }
      rmSync(entry.relocation.destination, { recursive: true, force: true });
    }
    rmSync(entry.stagingPath, { recursive: true, force: true });
  }
}

function finishRelocations(applied: readonly AppliedRelocation[]): void {
  for (const entry of applied) {
    rmSync(entry.relocation.source, { recursive: true, force: true });
    rmSync(entry.stagingPath, { recursive: true, force: true });
  }
}

function restoreRegistryFile(path: string, raw: string | null): void {
  if (raw === null) {
    rmSync(path, { force: true });
    return;
  }
  atomicWriteFileSync(path, raw);
}

function readFile(): InstalledPluginsFile {
  const path = installedPluginsPath();
  if (!existsSync(path)) return { ...EMPTY_FILE, plugins: {} };
  const raw = readRawFile(path);
  if (raw && raw.version === CURRENT_FILE_VERSION) return readCurrentFile(raw, path);
  mkdirSync(dirname(path), { recursive: true });
  return withFileLockSync(path, () => {
    const original = existsSync(path) ? readFileSync(path, "utf8") : null;
    const state = readFileUnlocked();
    if (!state.needsMigration) return state.file;
    const applied = applyRelocations(state.relocations);
    try {
      writeFile(path, state.file);
      finishRelocations(applied);
      return state.file;
    } catch (error) {
      rollbackRelocations(applied);
      restoreRegistryFile(path, original);
      throw error;
    }
  });
}

function updateFile(mutator: (file: InstalledPluginsFile) => void): InstalledPluginsFile {
  const path = installedPluginsPath();
  mkdirSync(dirname(path), { recursive: true });
  return withFileLockSync(path, () => {
    const raw = existsSync(path) ? readFileSync(path, "utf8") : null;
    const state = readFileUnlocked();
    const applied = state.needsMigration ? applyRelocations(state.relocations) : [];
    try {
      mutator(state.file);
      writeFile(path, state.file);
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
  return Object.values(readFile().plugins)
    .flat()
    .sort(
      (a, b) =>
        a.identity.localeCompare(b.identity) || a.installationId.localeCompare(b.installationId),
    );
}

function lookupFailure(
  target: string,
  code: "PLUGIN_NOT_FOUND" | "PLUGIN_AMBIGUOUS",
  candidates: readonly PluginId[] = [],
): PluginLookupResult {
  return { ok: false, code, target, candidates };
}

function relevantInstallations(
  installations: readonly PluginInstallation[],
  currentProjectPath: string,
): PluginInstallation[] {
  return installations.filter(
    (entry) =>
      entry.scope === "user" ||
      (entry.projectPath !== undefined &&
        normalizeProjectPath(entry.projectPath) === currentProjectPath),
  );
}

function selectInstallation(
  matches: readonly PluginInstallation[],
): PluginInstallation | undefined {
  const rank: Record<PluginInstallScope, number> = { local: 3, project: 2, user: 1 };
  const highestRank = Math.max(...matches.map((entry) => rank[entry.scope]));
  const highest = matches.filter((entry) => rank[entry.scope] === highestRank);
  return highest.length === 1 ? highest[0] : undefined;
}

export function lookupPluginInstallation(
  target: string,
  options?: PluginLookupOptions,
): PluginLookupResult {
  const currentProjectPath = normalizeProjectPath(options?.cwd ?? getTrackedCwd())!;
  const installations = relevantInstallations(listPluginInstallations(), currentProjectPath).filter(
    (entry) => options?.scope === undefined || entry.scope === options.scope,
  );
  if (parseInstallationId(target)) {
    const matches = installations.filter((entry) => entry.installationId === target);
    if (matches.length === 1) {
      return { ok: true, installation: matches[0]!, pluginId: matches[0]!.identity };
    }
    if (matches.length > 1) {
      return lookupFailure(
        target,
        "PLUGIN_AMBIGUOUS",
        matches.map((entry) => entry.identity),
      );
    }
    return lookupFailure(target, "PLUGIN_NOT_FOUND");
  }
  if (isPluginId(target)) {
    const matches = installations.filter((entry) => entry.identity === target);
    const selected = selectInstallation(matches);
    if (selected) return { ok: true, installation: selected, pluginId: target };
    if (matches.length > 1) {
      return lookupFailure(
        target,
        "PLUGIN_AMBIGUOUS",
        matches.map((entry) => entry.identity),
      );
    }
    return lookupFailure(target, "PLUGIN_NOT_FOUND");
  }
  if (target.includes("@")) return lookupFailure(target, "PLUGIN_NOT_FOUND");
  const matchesById = new Map<PluginId, PluginInstallation[]>();
  for (const installation of installations) {
    if (installation.pluginName !== target) continue;
    const matches = matchesById.get(installation.identity) ?? [];
    matches.push(installation);
    matchesById.set(installation.identity, matches);
  }
  const candidateIds = [...matchesById.keys()].sort();
  if (candidateIds.length === 0) return lookupFailure(target, "PLUGIN_NOT_FOUND");
  if (candidateIds.length !== 1) return lookupFailure(target, "PLUGIN_AMBIGUOUS", candidateIds);
  const matches = matchesById.get(candidateIds[0]!)!;
  const selected = selectInstallation(matches);
  if (selected) return { ok: true, installation: selected, pluginId: candidateIds[0]! };
  return lookupFailure(target, "PLUGIN_AMBIGUOUS", candidateIds);
}

export function resolvePluginInstallation(
  target: string,
  options?: PluginLookupOptions,
): PluginLookupResult {
  return lookupPluginInstallation(target, options);
}

export function findPluginInstallation(
  target: string,
  options?: PluginLookupOptions,
): PluginInstallation | undefined {
  const result = lookupPluginInstallation(target, options);
  return result.ok ? result.installation : undefined;
}

export function findPluginInstallationByPath(path: string): PluginInstallation | undefined {
  const resolved = resolve(path);
  const matches = listPluginInstallations().filter(
    (entry) => resolve(entry.installPath) === resolved,
  );
  if (matches.length > 1) {
    throw new PluginLookupError(
      "PLUGIN_AMBIGUOUS",
      path,
      matches.map((entry) => entry.identity),
    );
  }
  return matches[0];
}

export function pluginIdentity(target: string, options?: PluginLookupOptions): string {
  if (isPluginId(target)) return target;
  const result = lookupPluginInstallation(target, options);
  if (!result.ok) {
    throw new PluginLookupError(result.code, result.target, result.candidates);
  }
  return result.pluginId;
}

export function recordPluginInstallation(entry: PluginInstallationInput): PluginInstallation {
  let saved: PluginInstallation | undefined;
  updateFile((file) => {
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
  updateFile((file) => {
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
  updateFile((file) => {
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

export function forgetPluginInstallation(target: string): PluginInstallation | undefined {
  const found = findPluginInstallation(target);
  if (!found) return undefined;
  return removePluginInstallationById(found.installationId);
}

export function projectPathFromInstallPath(
  installPath: string,
  scope?: PluginInstallScope,
): string | undefined {
  const resolved = resolve(installPath);
  const segments = resolved.split(sep);
  for (let index = 0; index < segments.length - 3; index += 1) {
    if (
      segments[index] !== ".otherside" ||
      segments[index + 1] !== "plugins" ||
      !["installed", "installed-local"].includes(segments[index + 2] ?? "")
    ) {
      continue;
    }
    const directory = segments[index + 2]!;
    const inferredScope = directory === "installed" ? "project" : "local";
    if (scope !== undefined && scope !== inferredScope) return undefined;
    const projectPath = segments.slice(0, index).join(sep) || sep;
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    if (normalizedProjectPath === undefined) continue;
    const rawRoot = join(projectPath, ".otherside", "plugins", directory);
    if (resolve(rawRoot) !== resolved && isWithinLexicalRoot(rawRoot, resolved)) {
      return normalizedProjectPath;
    }
  }
  return undefined;
}

export function activeInstallPath(
  pluginName: string,
  scope: PluginInstallScope,
  marketplace: string,
  version: string,
  projectPath?: string,
): string {
  if (scope === "user" && projectPath !== undefined) {
    throw new Error("User-scope installations cannot have a project path");
  }
  const normalizedProjectPath = normalizeProjectPath(projectPath);
  if ((scope === "project" || scope === "local") && normalizedProjectPath === undefined) {
    throw new Error(`Project path is required for ${scope}-scope installations`);
  }
  const root =
    scope === "user"
      ? join(configRoot(), "plugins", "installed")
      : join(
          normalizedProjectPath!,
          ".otherside",
          "plugins",
          scope === "project" ? "installed" : "installed-local",
        );
  return confinedPath(
    root,
    encodePluginPathSegment(scope),
    encodePluginPathSegment(marketplace),
    encodePluginPathSegment(pluginName),
    encodePluginPathSegment(version),
  );
}

export function versionedInstallPathForPlugin(options: {
  marketplace: string;
  pluginName: string;
  version: string;
  scope: PluginInstallScope;
  projectPath?: string;
}): string {
  return activeInstallPath(
    options.pluginName,
    options.scope,
    options.marketplace,
    options.version,
    options.projectPath,
  );
}

export function cachePathForPlugin(
  marketplace: string,
  pluginName: string,
  version: string,
): string {
  return confinedPath(
    cacheRoot(),
    encodePluginPathSegment(marketplace),
    encodePluginPathSegment(pluginName),
    encodePluginPathSegment(version),
  );
}

export function pluginCacheRoot(): string {
  return join(configRoot(), "plugins", "cache");
}

function cacheRoot(): string {
  return pluginCacheRoot();
}

export function encodePluginPathSegment(value: string): string {
  if (typeof value !== "string") throw new TypeError("Plugin path segments must be strings");
  return `x${Buffer.from(value, "utf8").toString("hex")}`;
}

function confinedPath(root: string, ...segments: string[]): string {
  const target = resolve(root, ...segments);
  if (!isWithinRoot(root, target) || target === resolve(root)) {
    throw new Error(`Path escapes configured root: ${target}`);
  }
  return target;
}
