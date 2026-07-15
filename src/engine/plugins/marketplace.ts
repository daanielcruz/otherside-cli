import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import officialCatalogSeed from "@/engine/plugins/assets/official-plugin-catalog.json" with {
  type: "json",
};
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { atomicWriteFileSync } from "@/kernel/std/fs/secure-fs.ts";
import { cloneRepo } from "@/kernel/std/proc/git.ts";
import type { InstallResult } from "./install.ts";
import {
  activeInstallPath,
  cachePathForPlugin,
  findPluginInstallation,
  listPluginInstallations,
  type PluginInstallScope,
  recordPluginInstallation,
} from "./installations.ts";
import { loadPluginFromDirectory } from "./loader.ts";
import {
  addKnownMarketplace,
  getKnownMarketplace,
  type KnownMarketplace,
  listAvailableMarketplaces,
  type MarketplaceSourceType,
  OFFICIAL_MARKETPLACE_NAME,
  OFFICIAL_MARKETPLACE_SOURCE,
} from "./marketplaces-store.ts";
import { register } from "./registry.ts";

export { OFFICIAL_MARKETPLACE_NAME, OFFICIAL_MARKETPLACE_SOURCE };

export type PluginSource =
  | string
  | { source: "github"; repo: string; ref?: string; subdir?: string }
  | { source: "git" | "url"; url: string; ref?: string; subdir?: string }
  | { source: "git-subdir"; url: string; path: string; ref?: string }
  | { source: "file"; path: string };

export interface MarketplacePluginEntry {
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  installCount?: number;
  communityManaged?: boolean;
  source: PluginSource;
  strict?: boolean;
}

export interface MarketplaceManifest {
  name: string;
  owner?: { name?: string; email?: string; url?: string };
  plugins: MarketplacePluginEntry[];
  metadata?: { pluginRoot?: string; version?: string; description?: string };
}

export interface AddMarketplaceResult {
  ok: boolean;
  name?: string;
  count?: number;
  bumped?: number;
  error?: string;
}

const GITHUB_REPO_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const MANIFEST_PATHS = [".claude-plugin/marketplace.json", "marketplace.json"];
const OFFICIAL_MARKETPLACE_SPARSE_PATHS = [".claude-plugin", "plugins", "external_plugins"];

function isSafeName(value: string): boolean {
  return SAFE_NAME_RE.test(value) && value !== "." && value !== "..";
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function parsePluginSource(raw: unknown): PluginSource | null {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const kind = source.source;
  const ref = stringField(source, "ref");
  if (kind === "github" && typeof source.repo === "string") {
    return {
      source: "github",
      repo: source.repo,
      ...(ref ? { ref } : {}),
      ...(typeof source.subdir === "string" ? { subdir: source.subdir } : {}),
    };
  }
  if ((kind === "git" || kind === "url") && typeof source.url === "string") {
    return {
      source: kind,
      url: source.url,
      ...(ref ? { ref } : {}),
      ...(typeof source.subdir === "string" ? { subdir: source.subdir } : {}),
    };
  }
  if (kind === "git-subdir" && typeof source.url === "string" && typeof source.path === "string") {
    return {
      source: "git-subdir",
      url: source.url,
      path: source.path,
      ...(ref ? { ref } : {}),
    };
  }
  if (kind === "file" && typeof source.path === "string") {
    return { source: "file", path: source.path };
  }
  return null;
}

export function marketplacesCacheDir(): string {
  const dir = join(configRoot(), "plugins", "marketplaces");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function cacheDirFor(name: string): string {
  return join(marketplacesCacheDir(), name);
}

function githubUrl(repo: string): string {
  return repo.startsWith("https://") ? repo : `https://github.com/${repo}.git`;
}

function isOfficialMarketplaceSource(source: string): boolean {
  const normalized = source.replace(/\.git$/, "").replace(/\/$/, "");
  return (
    normalized === OFFICIAL_MARKETPLACE_SOURCE ||
    normalized === `https://github.com/${OFFICIAL_MARKETPLACE_SOURCE}`
  );
}

function cloneTargetFor(source: string): { url?: string } {
  const type = detectSourceType(source);
  if (type === "github") return { url: githubUrl(source) };
  if (type === "git") return { url: source };
  return {};
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

export function parseMarketplaceManifest(raw: unknown): MarketplaceManifest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string" || !isSafeName(obj.name)) return null;
  if (!Array.isArray(obj.plugins)) return null;
  const plugins: MarketplacePluginEntry[] = [];
  for (const entry of obj.plugins) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string" || !isSafeName(e.name)) continue;
    const source = parsePluginSource(e.source);
    if (!source) continue;
    const item: MarketplacePluginEntry = {
      name: e.name,
      source,
    };
    if (typeof e.description === "string") item.description = e.description;
    if (typeof e.category === "string") item.category = e.category;
    if (typeof e.installCount === "number") item.installCount = e.installCount;
    if (typeof e.communityManaged === "boolean") item.communityManaged = e.communityManaged;
    if (Array.isArray(e.tags)) {
      item.tags = e.tags.filter((t): t is string => typeof t === "string");
    }
    if (typeof e.strict === "boolean") item.strict = e.strict;
    plugins.push(item);
  }
  const result: MarketplaceManifest = { name: obj.name, plugins };
  if (typeof obj.owner === "object" && obj.owner !== null && !Array.isArray(obj.owner)) {
    const rawOwner = obj.owner as Record<string, unknown>;
    const owner = {
      ...(typeof rawOwner.name === "string" ? { name: rawOwner.name } : {}),
      ...(typeof rawOwner.email === "string" ? { email: rawOwner.email } : {}),
      ...(typeof rawOwner.url === "string" ? { url: rawOwner.url } : {}),
    };
    if (Object.keys(owner).length > 0) result.owner = owner;
  }
  if (typeof obj.metadata === "object" && obj.metadata !== null && !Array.isArray(obj.metadata)) {
    const rawMetadata = obj.metadata as Record<string, unknown>;
    const metadata = {
      ...(typeof rawMetadata.pluginRoot === "string" ? { pluginRoot: rawMetadata.pluginRoot } : {}),
      ...(typeof rawMetadata.version === "string" ? { version: rawMetadata.version } : {}),
      ...(typeof rawMetadata.description === "string"
        ? { description: rawMetadata.description }
        : {}),
    };
    if (Object.keys(metadata).length > 0) result.metadata = metadata;
  }
  return result;
}

export function detectSourceType(source: string): MarketplaceSourceType {
  if (/^https?:\/\//i.test(source) || /^git@/i.test(source) || /\.git$/i.test(source)) {
    return "git";
  }
  if (GITHUB_REPO_RE.test(source)) {
    return "github";
  }
  return "file";
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
  const res = cloneRepo(
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

export function addMarketplace(rawSource: string): AddMarketplaceResult {
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
    const res = cloneRepo(target.url, temp);
    if (!res.ok) {
      rmSync(temp, { recursive: true, force: true });
      return { ok: false, error: res.error ?? "git clone failed" };
    }
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
 * List plugins for a marketplace.
 *
 * Discover entry source (parity):
 * 1. Official marketplace CHECKOUT manifest (git clone via marketplace manager)
 * 2. Offline bundled seed — ONLY when there is no checkout and clone cannot run
 *
 * Install counts are a separate overlay from the plugin-stats catalog and never
 * supply Discover entries. The live catalog's `marketplace_entry` is opaque.
 */
export function listMarketplacePlugins(name: string): MarketplacePluginEntry[] {
  const officialCheckoutAvailable =
    name === OFFICIAL_MARKETPLACE_NAME ? ensureOfficialMarketplaceCheckout() : false;
  const cached = getCachedManifest(name)?.plugins ?? [];
  if (cached.length > 0) return enrichWithInstallCounts(name, cached);
  // Narrow offline gate: no checkout on disk AND this process's clone attempt failed.
  if (name === OFFICIAL_MARKETPLACE_NAME && !officialCheckoutAvailable) {
    return listOfflineOfficialSeedPlugins();
  }
  return [];
}

// ── Official marketplace checkout bootstrap ─────────────────────────────────
//
// Parity: fixed-pointer clone of anthropics/claude-plugins-official. Discover
// reads entries from this checkout. The plugin-stats catalog is counts-only.

let officialCheckoutCloneFailed = false;

/**
 * Ensure the official marketplace is cloned into the managed cache.
 * Idempotent: no-ops when a checkout manifest already exists. Attempts at most
 * once per process when the checkout is missing (clone failures are sticky so
 * Discover can fall back to the offline seed without re-cloning every render).
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

// ── Official plugin catalog (install counts ONLY) ───────────────────────────
//
// Reference mechanism (claude-code pluginCatalogCache / installCounts):
// fetch-with-cache of plugin-details.json (24h TTL). Counts overlay ONLY on
// entries where marketplaceName === official. The catalog is NEVER the Discover
// entry source when a checkout exists or can be produced.
//
// Bundled seed (assets/official-plugin-catalog.json): first-run OFFLINE FALLBACK
// for Discover entries only when there is no checkout AND clone cannot run.
// It is not an install-count source for checkout-backed Discover entries.

export const PLUGIN_CATALOG_VERSION = 1;
export const PLUGIN_CATALOG_CACHE_FILE = "plugin-catalog-cache.json";
/** Same public stats URL the reference uses for unique_installs. */
export const PLUGIN_CATALOG_URL =
  "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/plugin-stats/plugin-details.json";
export const PLUGIN_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

interface SeedCatalogPlugin {
  unique_installs?: number | null;
  /** Opaque upstream field — unused for Discover entry sourcing. */
  marketplace_entry?: Record<string, unknown>;
}

interface SeedCatalogFile {
  version: number;
  generated_at?: string | undefined;
  marketplace_sha?: string | undefined;
  marketplace?: string | undefined;
  plugins: Record<string, SeedCatalogPlugin>;
}

interface CachedCatalogFile {
  version: number;
  fetchedAt: string;
  catalog: SeedCatalogFile;
}

let memoryCatalog: SeedCatalogFile | null = null;
let catalogFetchPromise: Promise<SeedCatalogFile | null> | undefined;

function pluginCatalogCachePath(): string {
  return join(configRoot(), "plugins", PLUGIN_CATALOG_CACHE_FILE);
}

function isSeedCatalog(value: unknown): value is SeedCatalogFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.plugins === "object" && obj.plugins !== null && !Array.isArray(obj.plugins);
}

function loadBundledOfficialCatalog(): SeedCatalogFile {
  const seed = officialCatalogSeed as unknown;
  if (isSeedCatalog(seed)) return seed;
  return { version: PLUGIN_CATALOG_VERSION, plugins: {} };
}

function loadDiskCatalogCache(): SeedCatalogFile | null {
  const path = pluginCatalogCachePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CachedCatalogFile>;
    if (parsed.version !== PLUGIN_CATALOG_VERSION || !isSeedCatalog(parsed.catalog)) return null;
    const fetchedAt = new Date(parsed.fetchedAt ?? "").getTime();
    if (Number.isNaN(fetchedAt) || Date.now() - fetchedAt > PLUGIN_CATALOG_TTL_MS) return null;
    return parsed.catalog;
  } catch {
    return null;
  }
}

function saveDiskCatalogCache(catalog: SeedCatalogFile): void {
  try {
    const path = pluginCatalogCachePath();
    mkdirSync(dirname(path), { recursive: true });
    const payload: CachedCatalogFile = {
      version: PLUGIN_CATALOG_VERSION,
      fetchedAt: new Date().toISOString(),
      catalog,
    };
    atomicWriteFileSync(path, `${JSON.stringify(payload)}\n`, 0o600);
  } catch {
    // Best-effort cache.
  }
}

/**
 * Resolve the live install-counts catalog synchronously: in-memory → fresh disk
 * cache → empty. The bundled offline seed is deliberately not a counts source.
 */
export function getOfficialCatalogSync(): SeedCatalogFile {
  if (memoryCatalog) return memoryCatalog;
  const disk = loadDiskCatalogCache();
  if (disk) {
    memoryCatalog = disk;
    return disk;
  }
  return { version: PLUGIN_CATALOG_VERSION, plugins: {} };
}

/** Install-count map keyed by `plugin@marketplace` (reference shape). */
export function getInstallCountsSync(): Map<string, number> {
  const catalog = getOfficialCatalogSync();
  const counts = new Map<string, number>();
  for (const [pluginId, entry] of Object.entries(catalog.plugins)) {
    if (typeof entry.unique_installs === "number") counts.set(pluginId, entry.unique_installs);
  }
  return counts;
}

/**
 * Build a Discover entry from a seed catalog record.
 * Used ONLY by the offline fallback path (bundled seed) — not by the live
 * plugin-stats catalog (whose marketplace_entry is opaque / unused for Discover).
 */
function entryFromSeedRecord(
  pluginId: string,
  record: SeedCatalogPlugin,
): MarketplacePluginEntry | null {
  const raw = record.marketplace_entry;
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name : pluginId.split("@")[0];
  if (!name || !isSafeName(name)) return null;
  const source = parsePluginSource(raw.source);
  if (!source) return null;
  const item: MarketplacePluginEntry = { name, source };
  if (typeof raw.description === "string") item.description = raw.description;
  if (typeof raw.category === "string") item.category = raw.category;
  if (typeof raw.communityManaged === "boolean") item.communityManaged = raw.communityManaged;
  if (Array.isArray(raw.tags)) {
    item.tags = raw.tags.filter((t): t is string => typeof t === "string");
  }
  return item;
}

/**
 * Offline-only Discover entries from the BUNDLED seed (never disk/network
 * catalog). Callers must gate this behind "no checkout AND clone failed".
 */
function listOfflineOfficialSeedPlugins(): MarketplacePluginEntry[] {
  const seed = loadBundledOfficialCatalog();
  const out: MarketplacePluginEntry[] = [];
  for (const [pluginId, record] of Object.entries(seed.plugins)) {
    if (!pluginId.endsWith(`@${OFFICIAL_MARKETPLACE_NAME}`)) continue;
    const entry = entryFromSeedRecord(pluginId, record);
    if (entry) out.push(entry);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  // Counts still come only from a fresh live catalog cache, when available.
  return enrichWithInstallCounts(OFFICIAL_MARKETPLACE_NAME, out);
}

/**
 * Overlay install counts onto official-marketplace entries only (parity:
 * installCounts && plugin.marketplaceName === OFFICIAL_MARKETPLACE_NAME).
 * Fresher catalog counts win over any value already on the entry.
 */
function enrichWithInstallCounts(
  marketplace: string,
  plugins: MarketplacePluginEntry[],
): MarketplacePluginEntry[] {
  if (marketplace !== OFFICIAL_MARKETPLACE_NAME) return plugins;
  const counts = getInstallCountsSync();
  return plugins.map((plugin) => {
    const entry = { ...plugin };
    delete entry.installCount;
    const count = counts.get(`${plugin.name}@${marketplace}`);
    return count === undefined ? entry : { ...entry, installCount: count };
  });
}

/**
 * Best-effort network refresh of the install-counts catalog. Concurrent callers
 * share one promise. Failures leave the seed/cache untouched. Does NOT supply
 * Discover entries — counts/metadata only.
 */
export async function refreshOfficialCatalog(options?: {
  fetchImpl?: typeof fetch;
}): Promise<SeedCatalogFile | null> {
  if (catalogFetchPromise) return catalogFetchPromise;
  const disk = loadDiskCatalogCache();
  if (disk) {
    memoryCatalog = disk;
    return disk;
  }
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  catalogFetchPromise = (async () => {
    try {
      const response = await fetchImpl(PLUGIN_CATALOG_URL, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as {
        generated_at?: string;
        marketplace_sha?: string;
        plugins?: Record<string, Record<string, unknown>>;
      };
      if (!body.plugins || typeof body.plugins !== "object") {
        throw new Error("Invalid plugin catalog response");
      }
      const plugins: Record<string, SeedCatalogPlugin> = {};
      for (const [pluginId, value] of Object.entries(body.plugins)) {
        if (!pluginId.endsWith(`@${OFFICIAL_MARKETPLACE_NAME}`)) continue;
        const unique =
          typeof value.unique_installs === "number" ? value.unique_installs : undefined;
        // marketplace_entry is retained for cache fidelity but is opaque to Discover.
        const marketplaceEntry =
          value.marketplace_entry && typeof value.marketplace_entry === "object"
            ? (value.marketplace_entry as Record<string, unknown>)
            : undefined;
        plugins[pluginId] = {
          ...(unique !== undefined ? { unique_installs: unique } : {}),
          ...(marketplaceEntry ? { marketplace_entry: marketplaceEntry } : {}),
        };
      }
      const catalog: SeedCatalogFile = {
        version: PLUGIN_CATALOG_VERSION,
        generated_at: typeof body.generated_at === "string" ? body.generated_at : undefined,
        marketplace_sha:
          typeof body.marketplace_sha === "string" ? body.marketplace_sha : undefined,
        marketplace: OFFICIAL_MARKETPLACE_NAME,
        plugins,
      };
      memoryCatalog = catalog;
      saveDiskCatalogCache(catalog);
      return catalog;
    } catch {
      catalogFetchPromise = undefined;
      return null;
    }
  })();
  return catalogFetchPromise;
}

/** Test helper: drop memory + force next load from disk; reset checkout failure latch. */
export function _resetOfficialCatalogForTesting(): void {
  memoryCatalog = null;
  catalogFetchPromise = undefined;
  officialCheckoutCloneFailed = false;
}

/** Test helper: skip git bootstrap so offline-seed path can be exercised. */
export function _forceOfficialCheckoutFailedForTesting(): void {
  officialCheckoutCloneFailed = true;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(canonicalPath(root), canonicalPath(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function resolveFileSource(
  path: string,
  marketplaceDir: string,
  manifest: MarketplaceManifest,
): string | null {
  if (isAbsolute(path)) return null;
  const pluginRoot = manifest.metadata?.pluginRoot;
  if (pluginRoot && isAbsolute(pluginRoot)) return null;
  const base = pluginRoot ? resolve(marketplaceDir, pluginRoot) : resolve(marketplaceDir);
  if (!isWithinRoot(marketplaceDir, base)) return null;
  const target = resolve(base, path);
  return isWithinRoot(base, target) ? target : null;
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
    const res = cloneRepo(target.url, dest);
    return res.ok ? { ok: true } : { ok: false, error: res.error ?? "git clone failed" };
  }
  const rawUrl = source.source === "github" ? source.repo : source.url;
  const url =
    source.source === "github" || GITHUB_REPO_RE.test(rawUrl) ? githubUrl(rawUrl) : rawUrl;
  const ref = source.ref;
  const subdir = source.source === "git-subdir" ? source.path : source.subdir;
  if (subdir) {
    const temp = `${dest}.tmp`;
    const res = cloneRepo(url, temp, ref ? { ref } : {});
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
  const res = cloneRepo(url, dest, ref ? { ref } : {});
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

export function updateMarketplacePlugin(target: string): InstallResult {
  const installation = findPluginInstallation(target);
  if (!installation) return { success: false, message: `Plugin ${target} is not installed.` };
  return installMarketplacePlugin(installation.marketplace, installation.pluginName);
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
): InstallResult {
  const known = getKnownMarketplace(marketplaceName);
  if (!known) {
    return { success: false, message: `marketplace not found: ${marketplaceName}` };
  }
  let manifest = getCachedManifest(marketplaceName);
  if (!manifest && marketplaceName === OFFICIAL_MARKETPLACE_NAME) {
    manifest = fetchMarketplace(known).manifest;
  }
  if (!manifest) {
    return { success: false, message: `marketplace manifest not available: ${marketplaceName}` };
  }
  const entry = manifest.plugins.find((p) => p.name === pluginName);
  if (!entry) {
    return {
      success: false,
      message: `plugin ${pluginName} not in marketplace ${marketplaceName}`,
    };
  }
  const marketplaceDir =
    known.sourceType === "file" ? known.installLocation : cacheDirFor(marketplaceName);
  const previous = findPluginInstallation(`${pluginName}@${marketplaceName}`);
  const effectiveScope = previous?.scope ?? scope;
  const dest = activeInstallPath(pluginName, effectiveScope);
  mkdirSync(dirname(dest), { recursive: true });
  const stagingRoot = mkdtempSync(join(dirname(dest), `.install-${pluginName}-`));
  const staged = join(stagingRoot, "next");
  const backup = join(stagingRoot, "previous");
  try {
    const res = materializePluginSource(entry.source, staged, marketplaceDir, manifest);
    if (!res.ok) return { success: false, message: res.error ?? "install failed" };
    const validationError = validateInstalledPlugin(staged, entry, marketplaceName);
    if (validationError) return validationError;
    const stagedPlugin = loadPluginFromDirectory(staged, marketplaceName, {
      requireManifest: true,
    });
    if (!stagedPlugin)
      return { success: false, message: `plugin ${pluginName} could not be loaded` };
    const version = stagedPlugin.manifest.version || "0.0.0";
    const cachePath = cachePathForPlugin(marketplaceName, pluginName, version);
    if (!existsSync(cachePath)) {
      mkdirSync(dirname(cachePath), { recursive: true });
      cpSync(staged, cachePath, { recursive: true });
    }

    if (existsSync(dest)) renameSync(dest, backup);
    try {
      renameSync(staged, dest);
    } catch (error) {
      if (!existsSync(dest) && existsSync(backup)) renameSync(backup, dest);
      throw error;
    }
    const installation = recordPluginInstallation({
      pluginName,
      marketplace: marketplaceName,
      scope: effectiveScope,
      version,
      installPath: dest,
      cachePath,
    });
    const loaded = loadPluginFromDirectory(dest, marketplaceName, { requireManifest: true });
    if (loaded) register(loaded);
    return {
      success: true,
      message: `${previous ? "Updated" : "Installed"} ${installation.identity} to v${version} in ${installation.scope} scope.`,
      pluginName,
      identity: installation.identity,
      version,
    };
  } catch (error) {
    return {
      success: false,
      message: `install failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}
