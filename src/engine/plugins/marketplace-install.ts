import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { cloneRepoSync, headCommitSync } from "@/kernel/std/proc/git.ts";
import { getTrackedCwd } from "@/kernel/std/state/cwd-state.ts";
import {
  canonicalProjectPath,
  createPluginId,
  type InstallationId,
  type PluginId,
} from "./identity.ts";
import type { InstallResult } from "./install.ts";
import {
  activeInstallPath,
  cachePathForPlugin,
  formatPluginLookupFailure,
  listPluginInstallations,
  lookupPluginInstallation,
  type PluginInstallation,
  type PluginInstallScope,
  recordPluginInstallation,
  restorePluginInstallation,
} from "./installations.ts";
import { loadPluginFromDirectory } from "./loader.ts";
import {
  type AddMarketplaceResult,
  cacheDirFor,
  fetchMarketplace,
  getCachedManifest,
  listMarketplacePlugins,
  refreshMarketplace,
} from "./marketplace.ts";
import {
  cloneTargetFor,
  detectSourceType,
  GITHUB_REPO_RE,
  githubUrl,
  isWithinRoot,
  type MarketplaceManifest,
  type MarketplacePluginEntry,
  type PluginSource,
  resolveFileSource,
} from "./marketplace-manifest.ts";
import {
  getKnownMarketplace,
  type KnownMarketplace,
  listAvailableMarketplaces,
  OFFICIAL_MARKETPLACE_NAME,
} from "./marketplaces-store.ts";
import { payloadDigest } from "./payload-digest.ts";
import { get as getRegisteredPlugin } from "./registry.ts";
import {
  beginInstallation,
  finishInstallation,
  getSnapshot,
  replaceDiskState,
  replaceSnapshot,
  updateInstallation,
} from "./state.ts";

function materializePluginSource(
  source: PluginSource,
  dest: string,
  marketplaceDir: string,
  manifest: MarketplaceManifest,
): { ok: boolean; error?: string } {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  if (typeof source === "string" || (typeof source === "object" && source.source === "file")) {
    const rawPath = typeof source === "string" ? source : source.path;
    const type = typeof source === "string" ? detectSourceType(source) : "file";
    if (type === "file") {
      const resolved = resolveFileSource(rawPath, marketplaceDir, manifest);
      if (!resolved) return { ok: false, error: `source path escapes marketplace: ${rawPath}` };
      if (!existsSync(resolved)) return { ok: false, error: `source path not found: ${resolved}` };
      cpSync(resolved, dest, { recursive: true });
      return { ok: true };
    }
    const target = cloneTargetFor(rawPath);
    if (!target.url) return { ok: false, error: `cannot resolve source: ${rawPath}` };
    const res = cloneRepoSync(target.url, dest);
    return res.ok ? { ok: true } : { ok: false, error: res.error ?? "git clone failed" };
  }
  const rawUrl = source.source === "github" ? source.repo : source.url;
  const url =
    source.source === "github" || GITHUB_REPO_RE.test(rawUrl) ? githubUrl(rawUrl) : rawUrl;
  const ref = source.ref;
  const subdir = source.source === "git-subdir" ? source.path : source.subdir;
  if (subdir) {
    const temp = `${dest}.tmp`;
    const res = cloneRepoSync(url, temp, ref ? { ref } : {});
    if (!res.ok) return { ok: false, error: res.error ?? "git clone failed" };
    const sub = resolve(temp, subdir);
    if (!isWithinRoot(temp, sub) || sub === resolve(temp) || !existsSync(sub)) {
      rmSync(temp, { recursive: true, force: true });
      return { ok: false, error: `subdir not found: ${subdir}` };
    }
    renameSync(sub, dest);
    rmSync(temp, { recursive: true, force: true });
    return { ok: true };
  }
  const res = cloneRepoSync(url, dest, ref ? { ref } : {});
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? "git clone failed" };
}

function validateInstalledPlugin(
  dest: string,
  entry: MarketplacePluginEntry,
  marketplaceName: string,
): InstallResult | null {
  if (loadPluginFromDirectory(dest, marketplaceName, { requireManifest: true })) return null;
  const nestedManifest = join(dest, ".claude-plugin", "plugin.json");
  const flatManifest = join(dest, "plugin.json");
  if (entry.strict !== false || existsSync(nestedManifest) || existsSync(flatManifest)) {
    rmSync(dest, { recursive: true, force: true });
    return { success: false, message: `plugin ${entry.name} has an invalid or missing manifest` };
  }
  mkdirSync(join(dest, ".claude-plugin"), { recursive: true });
  writeFileSync(
    nestedManifest,
    `${JSON.stringify({ name: entry.name, description: entry.description }, null, 2)}\n`,
  );
  if (loadPluginFromDirectory(dest, marketplaceName, { requireManifest: true })) return null;
  rmSync(dest, { recursive: true, force: true });
  return { success: false, message: `plugin ${entry.name} could not be loaded` };
}

function installationForTarget(
  target: string,
  requestedScope: PluginInstallScope | undefined,
): ReturnType<typeof lookupPluginInstallation> {
  return lookupPluginInstallation(target, {
    cwd: getTrackedCwd(),
    ...(requestedScope === undefined ? {} : { scope: requestedScope }),
  });
}

export async function updateMarketplacePlugin(
  target: string,
  requestedScope?: PluginInstallScope,
  exactInstallationId?: InstallationId,
): Promise<InstallResult> {
  const result = exactInstallationId
    ? lookupPluginInstallation(exactInstallationId, {
        cwd: getTrackedCwd(),
        ...(requestedScope === undefined ? {} : { scope: requestedScope }),
      })
    : installationForTarget(target, requestedScope);
  if (!result.ok) return { success: false, message: formatPluginLookupFailure(result) };
  const installation = result.installation;
  const refreshed = await refreshMarketplaceCheckout(installation.marketplace);
  if (!refreshed.ok) {
    return {
      success: false,
      message: `Could not refresh marketplace ${installation.marketplace}: ${refreshed.error ?? "unknown error"}`,
    };
  }
  return installMarketplacePlugin(
    installation.marketplace,
    installation.pluginName,
    installation.scope,
    installation.installationId,
  );
}

/**
 * An update reinstalls from the marketplace's local copy, so a git marketplace is
 * re-fetched first. A local directory marketplace is read in place and has
 * nothing to fetch.
 */
function refreshMarketplaceCheckout(marketplaceName: string): Promise<AddMarketplaceResult> {
  const known = getKnownMarketplace(marketplaceName);
  if (!known || known.sourceType === "file") return Promise.resolve({ ok: true });
  return refreshMarketplace(known);
}

export function findMarketplacePlugin(pluginName: string): {
  marketplace: string;
  entry: MarketplacePluginEntry;
} | null {
  const matches: { marketplace: string; entry: MarketplacePluginEntry }[] = [];
  for (const marketplace of listAvailableMarketplaces()) {
    const entry = listMarketplacePlugins(marketplace.name).find(
      (plugin) => plugin.name === pluginName,
    );
    if (entry) matches.push({ marketplace: marketplace.name, entry });
  }
  return matches.length === 1 ? matches[0]! : null;
}

export function installMarketplacePlugin(
  marketplaceName: string,
  pluginName: string,
  scope: PluginInstallScope = "user",
  exactInstallationId?: InstallationId,
): InstallResult {
  const known = getKnownMarketplace(marketplaceName);
  if (!known) return { success: false, message: `marketplace not found: ${marketplaceName}` };
  let manifest = getCachedManifest(marketplaceName);
  if (!manifest && marketplaceName === OFFICIAL_MARKETPLACE_NAME) {
    manifest = fetchMarketplace(known).manifest;
  }
  if (!manifest) {
    return { success: false, message: `marketplace manifest not available: ${marketplaceName}` };
  }
  const entry = manifest.plugins.find((plugin) => plugin.name === pluginName);
  if (!entry) {
    return {
      success: false,
      message: `plugin ${pluginName} not in marketplace ${marketplaceName}`,
    };
  }

  const pluginId = createPluginId(pluginName, marketplaceName);
  const currentProjectPath = scope === "user" ? undefined : canonicalProjectPath(getTrackedCwd());
  const previous = exactInstallationId
    ? listPluginInstallations().find((item) => item.installationId === exactInstallationId)
    : listPluginInstallations().find(
        (item) =>
          item.identity === pluginId &&
          item.scope === scope &&
          (scope === "user" || item.projectPath === currentProjectPath),
      );
  if (
    exactInstallationId &&
    (!previous || previous.identity !== pluginId || previous.scope !== scope)
  ) {
    return {
      success: false,
      message: `Plugin installation ${exactInstallationId} was not found.`,
    };
  }
  const existingInstallation = listPluginInstallations().find((item) => item.identity === pluginId);
  if (!exactInstallationId && existingInstallation) {
    return {
      success: false,
      message: `Plugin '${pluginId}' is already installed. Use '/plugins' to manage existing plugins.`,
    };
  }
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
  const marketplaceDir =
    known.sourceType === "file" ? known.installLocation : cacheDirFor(marketplaceName);
  let stagingRoot = "";
  let staged = "";
  let backup = "";
  let destination = "";
  let swapped = false;
  let cacheCreated = false;
  let createdCachePath = "";
  let installation: ReturnType<typeof recordPluginInstallation> | undefined;
  try {
    mkdirSync(join(configRoot(), "plugins"), { recursive: true });
    const sourceStagingRoot = mkdtempSync(join(configRoot(), "plugins", ".plugin-install-"));
    stagingRoot = sourceStagingRoot;
    staged = join(stagingRoot, "payload");
    const materialized = materializePluginSource(entry.source, staged, marketplaceDir, manifest);
    if (!materialized.ok) {
      return complete({ success: false, message: materialized.error ?? "install failed" });
    }
    const validationError = validateInstalledPlugin(staged, entry, marketplaceName);
    if (validationError) return complete(validationError);
    const stagedPlugin = loadPluginFromDirectory(staged, marketplaceName, {
      requireManifest: true,
    });
    if (!stagedPlugin) {
      return complete({ success: false, message: `plugin ${pluginName} could not be loaded` });
    }
    const stagedDigest = payloadDigest(staged);
    if (previous && hasPayloadDigest(previous.installPath, stagedDigest)) {
      replaceSnapshot(stateBefore);
      return alreadyUpToDate(previous);
    }
    const version = installedVersionKey({
      manifestVersion: stagedPlugin.manifest.version,
      entry,
      marketplace: known,
      digest: stagedDigest,
    });
    destination = activeInstallPath(
      pluginName,
      scope,
      marketplaceName,
      version,
      currentProjectPath,
    );
    mkdirSync(dirname(destination), { recursive: true });
    backup = join(stagingRoot, "previous");
    const cachePath = cachePathForPlugin(marketplaceName, pluginName, version);
    if (!existsSync(cachePath)) {
      mkdirSync(dirname(cachePath), { recursive: true });
      cpSync(staged, cachePath, { recursive: true });
      cacheCreated = true;
      createdCachePath = cachePath;
    }
    if (previous && resolve(previous.installPath) === destination) {
      if (!existsSync(destination))
        throw new Error(`previous plugin payload is missing: ${previous.installPath}`);
      if (isLoadedFrom(pluginId, destination))
        throw new Error(
          `${version} changed without a version bump and cannot be replaced while it is loaded`,
        );
      renameSync(destination, backup);
    } else if (previous) {
      if (existsSync(destination)) {
        if (isLoadedFrom(pluginId, destination))
          throw new Error(`${version} is still loaded; run /reload before updating again`);
        renameSync(destination, backup);
      }
      if (!existsSync(previous.installPath))
        throw new Error(`previous plugin payload is missing: ${previous.installPath}`);
    } else if (existsSync(destination)) {
      renameSync(destination, backup);
    }
    renameSync(staged, destination);
    swapped = true;
    const loaded = loadPluginFromDirectory(destination, pluginId, {
      requireManifest: true,
      reportErrors: true,
    });
    if (!loaded) throw new Error(`plugin ${pluginName} could not be loaded after swap`);
    installation = recordPluginInstallation({
      pluginId,
      scope,
      ...(currentProjectPath === undefined ? {} : { projectPath: currentProjectPath }),
      version,
      installPath: destination,
      cachePath,
    });
    const result = complete({
      success: true,
      message: previous
        ? `Updated ${installation.identity} to ${version}. Run /reload to activate.`
        : `Installed ${installation.identity}. Run /reload to activate.`,
      pluginName,
      identity: installation.identity,
      version,
    });
    if (backup && existsSync(backup)) rmSync(backup, { recursive: true, force: true });
    return result;
  } catch (error) {
    if (installation) restorePluginInstallation(installation.installationId, previous);
    if (swapped && existsSync(destination)) rmSync(destination, { recursive: true, force: true });
    // Every branch above moves `destination` aside, so that is where the backup returns.
    if (backup && existsSync(backup)) {
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(backup, destination);
    }
    if (cacheCreated && createdCachePath)
      rmSync(createdCachePath, { recursive: true, force: true });
    return complete({
      success: false,
      message: `install failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    if (stagingRoot) rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function hasPayloadDigest(payloadDir: string, digest: string): boolean {
  return existsSync(payloadDir) && payloadDigest(payloadDir) === digest;
}

function alreadyUpToDate(installation: PluginInstallation): InstallResult {
  return {
    success: true,
    changed: false,
    message: `${installation.identity} is already up to date.`,
    pluginName: installation.pluginName,
    identity: installation.identity,
    version: installation.version,
  };
}

interface StagedPayload {
  readonly manifestVersion: string | undefined;
  readonly entry: MarketplacePluginEntry;
  readonly marketplace: KnownMarketplace;
  readonly digest: string;
}

/**
 * The folder key an installed payload is stored under. A declared version wins:
 * the plugin's own, then its marketplace entry's. An unversioned payload is keyed
 * by its source revision, so changed content lands in a new folder and the copy a
 * session has loaded stays intact until /reload.
 */
function installedVersionKey(payload: StagedPayload): string {
  return payload.manifestVersion || payload.entry.version || sourceRevision(payload);
}

const SOURCE_REVISION_LENGTH = 12;

/**
 * The commit of the git marketplace checkout an unversioned plugin ships inside.
 * A local marketplace is edited in place and a plugin fetched from its own
 * repository moves independently of the marketplace commit, so both are keyed
 * by the payload's own digest instead.
 */
function sourceRevision({ entry, marketplace, digest }: StagedPayload): string {
  const checkoutCommit =
    marketplace.sourceType !== "file" && shipsInsideMarketplace(entry.source)
      ? headCommitSync(cacheDirFor(marketplace.name))
      : null;
  return (checkoutCommit ?? digest).slice(0, SOURCE_REVISION_LENGTH);
}

function shipsInsideMarketplace(source: PluginSource): boolean {
  if (typeof source === "string") return detectSourceType(source) === "file";
  return source.source === "file";
}

/** Whether this session's registered copy of the plugin is read from `payloadDir`. */
function isLoadedFrom(pluginId: PluginId, payloadDir: string): boolean {
  const loaded = getRegisteredPlugin(pluginId);
  return !!loaded && resolve(loaded.path) === resolve(payloadDir);
}
