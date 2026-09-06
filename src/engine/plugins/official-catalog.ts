import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { atomicWriteFileSync } from "@/kernel/std/fs/secure-fs.ts";
import type { MarketplacePluginEntry } from "./marketplace-manifest.ts";
import { OFFICIAL_MARKETPLACE_NAME } from "./marketplaces-store.ts";

// Plugin-stats catalog mechanism:
// fetch-with-cache of plugin-details.json (24h TTL). Install counts and
// last-updated stamps overlay ONLY on entries where marketplaceName ===
// official. The catalog is never a Discover entry source; its
// `marketplace_entry` data is opaque.

export const PLUGIN_CATALOG_VERSION = 1;
export const PLUGIN_CATALOG_CACHE_FILE = "plugin-catalog-cache.json";
/** Public stats URL for unique_installs. */
export const PLUGIN_CATALOG_URL =
  "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/plugin-stats/plugin-details.json";
export const PLUGIN_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

interface OfficialCatalogPlugin {
  unique_installs?: number | null;
  last_updated?: string | null;
  /** Opaque catalog field — unused for Discover entry sourcing. */
  marketplace_entry?: Record<string, unknown>;
}

interface OfficialCatalogFile {
  version: number;
  generated_at?: string | undefined;
  marketplace_sha?: string | undefined;
  marketplace?: string | undefined;
  plugins: Record<string, OfficialCatalogPlugin>;
}

interface CachedCatalogFile {
  version: number;
  fetchedAt: string;
  catalog: OfficialCatalogFile;
}

let memoryCatalog: OfficialCatalogFile | null = null;
let catalogFetchPromise: Promise<OfficialCatalogFile | null> | undefined;

function pluginCatalogCachePath(): string {
  return join(configRoot(), "plugins", PLUGIN_CATALOG_CACHE_FILE);
}

function isOfficialCatalog(value: unknown): value is OfficialCatalogFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.plugins === "object" && obj.plugins !== null && !Array.isArray(obj.plugins);
}

function loadDiskCatalogCache(): OfficialCatalogFile | null {
  const path = pluginCatalogCachePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CachedCatalogFile>;
    if (parsed.version !== PLUGIN_CATALOG_VERSION || !isOfficialCatalog(parsed.catalog))
      return null;
    const fetchedAt = new Date(parsed.fetchedAt ?? "").getTime();
    if (Number.isNaN(fetchedAt) || Date.now() - fetchedAt > PLUGIN_CATALOG_TTL_MS) return null;
    return parsed.catalog;
  } catch {
    return null;
  }
}

function saveDiskCatalogCache(catalog: OfficialCatalogFile): void {
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

/** Resolve the live install-counts catalog synchronously: in-memory → fresh disk → empty. */
export function getOfficialCatalogSync(): OfficialCatalogFile {
  if (memoryCatalog) return memoryCatalog;
  const disk = loadDiskCatalogCache();
  if (disk) {
    memoryCatalog = disk;
    return disk;
  }
  return { version: PLUGIN_CATALOG_VERSION, plugins: {} };
}

/** Install-count map keyed by `plugin@marketplace`. */
export function getInstallCountsSync(): Map<string, number> {
  const catalog = getOfficialCatalogSync();
  const counts = new Map<string, number>();
  for (const [pluginId, entry] of Object.entries(catalog.plugins)) {
    if (typeof entry.unique_installs === "number") counts.set(pluginId, entry.unique_installs);
  }
  return counts;
}

/** Last-updated timestamps keyed by `plugin@marketplace` (catalog-carried). */
export function getLastUpdatedSync(): Map<string, string> {
  const catalog = getOfficialCatalogSync();
  const stamps = new Map<string, string>();
  for (const [pluginId, entry] of Object.entries(catalog.plugins)) {
    if (typeof entry.last_updated === "string") stamps.set(pluginId, entry.last_updated);
  }
  return stamps;
}

/**
 * Overlay catalog stats onto official-marketplace entries only
 * (marketplaceName === OFFICIAL_MARKETPLACE_NAME).
 * Fresher catalog values win over any value already on the entry.
 */
export function enrichWithCatalogStats(
  marketplace: string,
  plugins: MarketplacePluginEntry[],
): MarketplacePluginEntry[] {
  if (marketplace !== OFFICIAL_MARKETPLACE_NAME) return plugins;
  const counts = getInstallCountsSync();
  const stamps = getLastUpdatedSync();
  const keyPrefix = `@${marketplace}`;
  return plugins.map((plugin) => {
    const entry = { ...plugin };
    delete entry.installCount;
    delete entry.lastUpdated;
    const key = `${plugin.name}${keyPrefix}`;
    const count = counts.get(key);
    const stamp = stamps.get(key);
    return {
      ...entry,
      ...(count === undefined ? {} : { installCount: count }),
      ...(stamp === undefined ? {} : { lastUpdated: stamp }),
    };
  });
}

/**
 * Best-effort network refresh of the plugin-stats catalog. Concurrent callers
 * share one promise. Failures preserve the current cache. Does not supply
 * Discover entries — stats only.
 */
export async function refreshOfficialCatalog(options?: {
  fetchImpl?: typeof fetch;
}): Promise<OfficialCatalogFile | null> {
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
      const plugins: Record<string, OfficialCatalogPlugin> = {};
      for (const [pluginId, value] of Object.entries(body.plugins)) {
        if (!pluginId.endsWith(`@${OFFICIAL_MARKETPLACE_NAME}`)) continue;
        const unique =
          typeof value.unique_installs === "number" ? value.unique_installs : undefined;
        const lastUpdated = typeof value.last_updated === "string" ? value.last_updated : undefined;
        // marketplace_entry is retained for cache fidelity but is opaque to Discover.
        const marketplaceEntry =
          value.marketplace_entry && typeof value.marketplace_entry === "object"
            ? (value.marketplace_entry as Record<string, unknown>)
            : undefined;
        plugins[pluginId] = {
          ...(unique !== undefined ? { unique_installs: unique } : {}),
          ...(lastUpdated !== undefined ? { last_updated: lastUpdated } : {}),
          ...(marketplaceEntry ? { marketplace_entry: marketplaceEntry } : {}),
        };
      }
      const catalog: OfficialCatalogFile = {
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

/** Test helper: drop memory + force next load from disk. */
export function resetOfficialCatalogStateForTests(): void {
  memoryCatalog = null;
  catalogFetchPromise = undefined;
}
