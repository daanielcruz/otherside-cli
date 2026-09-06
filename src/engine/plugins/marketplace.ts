import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { cloneRepo, cloneRepoSync } from "@/kernel/std/proc/git.ts";
import { listPluginInstallations } from "./installations.ts";
import { loadPluginFromDirectory } from "./loader.ts";
import {
  cloneTargetFor,
  detectSourceType,
  type MarketplaceManifest,
  type MarketplacePluginEntry,
  parseMarketplaceManifest,
  resolveFileSource,
} from "./marketplace-manifest.ts";
import {
  addKnownMarketplace,
  getKnownMarketplace,
  type KnownMarketplace,
  listAvailableMarketplaces,
  OFFICIAL_MARKETPLACE_NAME,
  OFFICIAL_MARKETPLACE_SOURCE,
} from "./marketplaces-store.ts";
import { enrichWithCatalogStats, resetOfficialCatalogStateForTests } from "./official-catalog.ts";

export { OFFICIAL_MARKETPLACE_NAME, OFFICIAL_MARKETPLACE_SOURCE };

export interface AddMarketplaceResult {
  ok: boolean;
  name?: string;
  count?: number;
  bumped?: number;
  error?: string;
}

const MANIFEST_PATHS = [".claude-plugin/marketplace.json", "marketplace.json"];
const OFFICIAL_MARKETPLACE_SPARSE_PATHS = [".claude-plugin", "plugins", "external_plugins"];
const ADD_CLONE_TIMEOUT_MS = 120_000;

export function marketplacesCacheDir(): string {
  const dir = join(configRoot(), "plugins", "marketplaces");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function cacheDirFor(name: string): string {
  return join(marketplacesCacheDir(), name);
}

function isOfficialMarketplaceSource(source: string): boolean {
  const normalized = source.replace(/\.git$/, "").replace(/\/$/, "");
  return (
    normalized === OFFICIAL_MARKETPLACE_SOURCE ||
    normalized === `https://github.com/${OFFICIAL_MARKETPLACE_SOURCE}`
  );
}

function readManifestAt(dir: string): MarketplaceManifest | null {
  for (const rel of MANIFEST_PATHS) {
    const file = join(dir, rel);
    if (!existsSync(file)) continue;
    try {
      return parseMarketplaceManifest(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return null;
    }
  }
  return null;
}

export function fetchMarketplace(known: KnownMarketplace): {
  manifest: MarketplaceManifest | null;
  error?: string;
} {
  if (known.sourceType === "file") {
    const dir = known.installLocation || known.source;
    if (!existsSync(dir)) {
      return { manifest: null, error: `marketplace path not found: ${dir}` };
    }
    const manifest = readManifestAt(dir);
    if (!manifest) return { manifest: null, error: `no marketplace manifest in ${dir}` };
    return { manifest };
  }
  const target = cloneTargetFor(known.source);
  if (!target.url) {
    return { manifest: null, error: `cannot resolve git source: ${known.source}` };
  }
  const dest = cacheDirFor(known.name);
  const res = cloneRepoSync(
    target.url,
    dest,
    known.name === OFFICIAL_MARKETPLACE_NAME
      ? { sparsePaths: OFFICIAL_MARKETPLACE_SPARSE_PATHS }
      : {},
  );
  if (!res.ok) return { manifest: null, error: res.error ?? "git clone failed" };
  const manifest = readManifestAt(dest);
  if (!manifest) return { manifest: null, error: `no marketplace manifest in ${known.source}` };
  return { manifest };
}

export async function addMarketplace(
  rawSource: string,
  onProgress?: (message: string) => void,
): Promise<AddMarketplaceResult> {
  const type = detectSourceType(rawSource);
  let manifest: MarketplaceManifest | null = null;
  let installLocation = "";
  if (type === "file") {
    if (!existsSync(rawSource)) return { ok: false, error: `path not found: ${rawSource}` };
    manifest = readManifestAt(rawSource);
    if (manifest?.name === OFFICIAL_MARKETPLACE_NAME) {
      return { ok: false, error: "the official marketplace source is fixed" };
    }
    installLocation = rawSource;
  } else {
    const target = cloneTargetFor(rawSource);
    if (!target.url) return { ok: false, error: `cannot resolve git source: ${rawSource}` };
    const temp = mkdtempSync(join(marketplacesCacheDir(), ".marketplace-"));
    // A source already on the roster is being refreshed, not fetched for the first
    // time; the progress line names which of the two the wait is for.
    const seconds = ADD_CLONE_TIMEOUT_MS / 1000;
    const onRoster = listAvailableMarketplaces().some((entry) => entry.source === rawSource);
    onProgress?.(
      onRoster
        ? `Refreshing marketplace cache (timeout: ${seconds}s)…`
        : `Cloning repository (timeout: ${seconds}s): ${target.url}`,
    );
    const res = await cloneRepo(target.url, temp, { timeoutMs: ADD_CLONE_TIMEOUT_MS });
    if (!res.ok) {
      rmSync(temp, { recursive: true, force: true });
      return { ok: false, error: res.error ?? "git clone failed" };
    }
    onProgress?.("Clone complete, validating marketplace…");
    manifest = readManifestAt(temp);
    if (!manifest) {
      rmSync(temp, { recursive: true, force: true });
      return { ok: false, error: `no marketplace manifest in ${rawSource}` };
    }
    if (manifest.name === OFFICIAL_MARKETPLACE_NAME && !isOfficialMarketplaceSource(rawSource)) {
      rmSync(temp, { recursive: true, force: true });
      return { ok: false, error: "the official marketplace source is fixed" };
    }
    const finalDir = cacheDirFor(manifest.name);
    const backup = `${temp}.previous`;
    try {
      if (existsSync(finalDir)) renameSync(finalDir, backup);
      renameSync(temp, finalDir);
      rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      if (!existsSync(finalDir) && existsSync(backup)) renameSync(backup, finalDir);
      rmSync(temp, { recursive: true, force: true });
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    installLocation = finalDir;
  }
  if (!manifest) return { ok: false, error: "invalid marketplace manifest" };
  addKnownMarketplace({
    name: manifest.name,
    source: rawSource,
    sourceType: type,
    installLocation,
    lastUpdated: new Date().toISOString(),
  });
  const bumped = countAvailablePluginUpdates(manifest, installLocation);
  return { ok: true, name: manifest.name, count: manifest.plugins.length, bumped };
}

export function getCachedManifest(name: string): MarketplaceManifest | null {
  const known = getKnownMarketplace(name);
  if (!known) return null;
  const dir = known.sourceType === "file" ? known.installLocation : cacheDirFor(name);
  if (!existsSync(dir)) return null;
  return readManifestAt(dir);
}

/**
 * List plugins from a marketplace checkout manifest.
 *
 * The official checkout is cloned on demand. Install counts and last-updated
 * stamps are a separate overlay from the plugin-stats catalog and never
 * supply Discover entries. The catalog's `marketplace_entry` remains opaque.
 */
export function listMarketplacePlugins(name: string): MarketplacePluginEntry[] {
  if (name === OFFICIAL_MARKETPLACE_NAME) ensureOfficialMarketplaceCheckout();
  const cached = getCachedManifest(name)?.plugins ?? [];
  return cached.length > 0 ? enrichWithCatalogStats(name, cached) : [];
}

// ── Official marketplace checkout bootstrap ─────────────────────────────────
//
// Fixed-pointer clone of the official plugins marketplace repo. Discover
// reads entries from this checkout. The plugin-stats catalog is stats-only.

let officialCheckoutCloneFailed = false;

/**
 * Ensure the official marketplace is cloned into the managed cache.
 * Idempotent: no-ops when a checkout manifest already exists. Attempts at most
 * once per process when the checkout is missing (clone failures are sticky to
 * avoid retrying on every Discover render).
 *
 * @returns true when a checkout manifest is available after the call
 */
export function ensureOfficialMarketplaceCheckout(): boolean {
  const existing = getCachedManifest(OFFICIAL_MARKETPLACE_NAME);
  if (existing) return true;
  if (officialCheckoutCloneFailed) return false;

  const known = getKnownMarketplace(OFFICIAL_MARKETPLACE_NAME);
  if (!known) {
    officialCheckoutCloneFailed = true;
    return false;
  }

  const { manifest } = fetchMarketplace(known);
  if (!manifest) {
    officialCheckoutCloneFailed = true;
    return false;
  }

  const installLocation =
    known.sourceType === "file" ? known.installLocation : cacheDirFor(OFFICIAL_MARKETPLACE_NAME);
  addKnownMarketplace({
    name: OFFICIAL_MARKETPLACE_NAME,
    source: known.source || OFFICIAL_MARKETPLACE_SOURCE,
    sourceType: known.sourceType,
    installLocation,
    lastUpdated: new Date().toISOString(),
    builtIn: true,
  });
  return true;
}

/** Whether a real official marketplace checkout (manifest) is on disk. */
export function hasOfficialMarketplaceCheckout(): boolean {
  return getCachedManifest(OFFICIAL_MARKETPLACE_NAME) !== null;
}

/** Test helper: drop catalog memory + force next load from disk; reset checkout failure latch. */
export function _resetOfficialCatalogForTesting(): void {
  resetOfficialCatalogStateForTests();
  officialCheckoutCloneFailed = false;
}

/** Test helper: prevent a checkout bootstrap attempt. */
export function _markOfficialCheckoutUnavailableForTesting(): void {
  officialCheckoutCloneFailed = true;
}

function countAvailablePluginUpdates(
  manifest: MarketplaceManifest,
  marketplaceDir: string,
): number {
  let bumped = 0;
  const installed = listPluginInstallations().filter(
    (installation) => installation.marketplace === manifest.name,
  );
  for (const installation of installed) {
    const entry = manifest.plugins.find((plugin) => plugin.name === installation.pluginName);
    if (!entry) continue;
    const rawPath =
      typeof entry.source === "string"
        ? entry.source
        : entry.source.source === "file"
          ? entry.source.path
          : undefined;
    if (!rawPath) continue;
    const sourceDir = resolveFileSource(rawPath, marketplaceDir, manifest);
    if (!sourceDir || !existsSync(sourceDir)) continue;
    const available = loadPluginFromDirectory(sourceDir, manifest.name, { requireManifest: true });
    if (available?.manifest.version && available.manifest.version !== installation.version)
      bumped += 1;
  }
  return bumped;
}
