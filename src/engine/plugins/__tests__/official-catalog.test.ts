import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _forceOfficialCheckoutFailedForTesting,
  _resetOfficialCatalogForTesting,
  getInstallCountsSync,
  hasOfficialMarketplaceCheckout,
  listMarketplacePlugins,
  PLUGIN_CATALOG_VERSION,
  refreshOfficialCatalog,
} from "@/engine/plugins/marketplace.ts";
import {
  addKnownMarketplace,
  OFFICIAL_MARKETPLACE_NAME,
  OFFICIAL_MARKETPLACE_SOURCE,
} from "@/engine/plugins/marketplaces-store.ts";

describe("official plugin catalog + checkout Discover sourcing", () => {
  let previousConfigDir: string | undefined;
  let configDir: string;

  beforeEach(() => {
    previousConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), "otherside-official-catalog-"));
    process.env.OTHERSIDE_CONFIG_DIR = configDir;
    _resetOfficialCatalogForTesting();
  });

  afterEach(() => {
    _resetOfficialCatalogForTesting();
    if (previousConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = previousConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  function writeOfficialCheckout(plugins: Array<Record<string, unknown>>): void {
    const mpDir = join(configDir, "plugins", "marketplaces", OFFICIAL_MARKETPLACE_NAME);
    mkdirSync(join(mpDir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(mpDir, ".claude-plugin", "marketplace.json"),
      `${JSON.stringify({
        name: OFFICIAL_MARKETPLACE_NAME,
        owner: { name: "Anthropic" },
        plugins,
      })}\n`,
      "utf8",
    );
    addKnownMarketplace({
      name: OFFICIAL_MARKETPLACE_NAME,
      source: OFFICIAL_MARKETPLACE_SOURCE,
      sourceType: "github",
      installLocation: mpDir,
      lastUpdated: new Date().toISOString(),
      builtIn: true,
    });
  }

  it("reaches the bundled seed only through the failed-checkout fallback", () => {
    _forceOfficialCheckoutFailedForTesting();
    const entries = listMarketplacePlugins(OFFICIAL_MARKETPLACE_NAME);

    expect(entries).toHaveLength(255);
    // The seed supplies offline entries, not install counts.
    expect(entries.some((entry) => entry.installCount !== undefined)).toBe(false);
    expect(getInstallCountsSync()).toEqual(new Map());
  });

  it("listMarketplacePlugins falls back to offline seed only when checkout is missing", () => {
    // Force the bootstrap latch so we do not attempt a live git clone in tests.
    _forceOfficialCheckoutFailedForTesting();
    expect(hasOfficialMarketplaceCheckout()).toBe(false);

    const listed = listMarketplacePlugins(OFFICIAL_MARKETPLACE_NAME);
    expect(listed).toHaveLength(255);
    expect(listed.some((entry) => entry.installCount !== undefined)).toBe(false);
  });

  it("does not use the seed when an empty checkout manifest is present", () => {
    writeOfficialCheckout([]);
    _forceOfficialCheckoutFailedForTesting();

    expect(hasOfficialMarketplaceCheckout()).toBe(true);
    expect(listMarketplacePlugins(OFFICIAL_MARKETPLACE_NAME)).toEqual([]);
  });

  it("prefers the official marketplace CHECKOUT over the offline seed", () => {
    writeOfficialCheckout([
      {
        name: "checkout-only-plugin",
        description: "from git checkout",
        installCount: 999,
        source: { source: "github", repo: "example/checkout-only" },
      },
    ]);
    _resetOfficialCatalogForTesting();

    expect(hasOfficialMarketplaceCheckout()).toBe(true);
    const listed = listMarketplacePlugins(OFFICIAL_MARKETPLACE_NAME);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe("checkout-only-plugin");
    // Entry-local counts are ignored; only the live cache may supply them.
    expect(listed[0]?.installCount).toBeUndefined();
    // Seed has hundreds of plugins — must not be mixed in when checkout exists.
    expect(listed.length).toBeLessThan(10);
  });

  it("overlays install counts from the plugin-stats catalog onto checkout entries", () => {
    writeOfficialCheckout([
      {
        name: "popular-plugin",
        description: "needs a count overlay",
        source: { source: "github", repo: "example/popular" },
      },
      {
        name: "quiet-plugin",
        source: { source: "github", repo: "example/quiet" },
      },
    ]);

    const cacheDir = join(configDir, "plugins");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "plugin-catalog-cache.json"),
      `${JSON.stringify({
        version: PLUGIN_CATALOG_VERSION,
        fetchedAt: new Date().toISOString(),
        catalog: {
          version: PLUGIN_CATALOG_VERSION,
          marketplace: OFFICIAL_MARKETPLACE_NAME,
          plugins: {
            [`popular-plugin@${OFFICIAL_MARKETPLACE_NAME}`]: {
              unique_installs: 12345,
              // marketplace_entry is opaque — present but not used as Discover source
              marketplace_entry: {
                name: "popular-plugin",
                source: { source: "github", repo: "example/should-not-replace-checkout" },
              },
            },
            [`quiet-plugin@${OFFICIAL_MARKETPLACE_NAME}`]: {
              marketplace_entry: {
                name: "quiet-plugin",
                installCount: 777,
                source: { source: "github", repo: "example/quiet" },
              },
            },
          },
        },
      })}\n`,
      "utf8",
    );
    _resetOfficialCatalogForTesting();

    const listed = listMarketplacePlugins(OFFICIAL_MARKETPLACE_NAME);
    expect(listed.map((p) => p.name).sort()).toEqual(["popular-plugin", "quiet-plugin"]);
    const popular = listed.find((p) => p.name === "popular-plugin");
    expect(popular?.installCount).toBe(12345);
    // Quiet has no catalog count — remains undefined (not invented).
    const quiet = listed.find((p) => p.name === "quiet-plugin");
    expect(quiet?.installCount).toBeUndefined();
  });

  it("does not use live catalog marketplace_entry as Discover source when disk cache exists without checkout", () => {
    const cacheDir = join(configDir, "plugins");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "plugin-catalog-cache.json"),
      `${JSON.stringify({
        version: PLUGIN_CATALOG_VERSION,
        fetchedAt: new Date().toISOString(),
        catalog: {
          version: PLUGIN_CATALOG_VERSION,
          marketplace: OFFICIAL_MARKETPLACE_NAME,
          plugins: {
            [`cache-only@${OFFICIAL_MARKETPLACE_NAME}`]: {
              unique_installs: 42,
              marketplace_entry: {
                name: "cache-only",
                source: { source: "github", repo: "example/cache-only" },
              },
            },
          },
        },
      })}\n`,
      "utf8",
    );
    _resetOfficialCatalogForTesting();
    _forceOfficialCheckoutFailedForTesting();

    const listed = listMarketplacePlugins(OFFICIAL_MARKETPLACE_NAME);
    // Offline seed entries, not the disk catalog's marketplace_entry list.
    expect(listed.some((entry) => entry.name === "cache-only")).toBe(false);
    expect(listed.length).toBeGreaterThan(10);
  });

  it("refreshOfficialCatalog reuses a fresh disk cache without fetching", async () => {
    const cacheDir = join(configDir, "plugins");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "plugin-catalog-cache.json"),
      `${JSON.stringify({
        version: PLUGIN_CATALOG_VERSION,
        fetchedAt: new Date().toISOString(),
        catalog: {
          version: PLUGIN_CATALOG_VERSION,
          marketplace: OFFICIAL_MARKETPLACE_NAME,
          plugins: {
            [`cache-only@${OFFICIAL_MARKETPLACE_NAME}`]: {
              unique_installs: 42,
              marketplace_entry: {
                name: "cache-only",
                source: { source: "github", repo: "example/cache-only" },
              },
            },
          },
        },
      })}\n`,
      "utf8",
    );
    let fetchCalls = 0;

    const catalog = await refreshOfficialCatalog({
      fetchImpl: (async () => {
        fetchCalls += 1;
        throw new Error("network should not be used for a fresh cache");
      }) as unknown as typeof fetch,
    });

    expect(fetchCalls).toBe(0);
    expect(catalog?.plugins[`cache-only@${OFFICIAL_MARKETPLACE_NAME}`]?.unique_installs).toBe(42);
  });

  it("refreshOfficialCatalog writes counts via injected fetch (not Discover entries)", async () => {
    const body = {
      generated_at: "2026-01-01T00:00:00.000Z",
      marketplace_sha: "abc",
      plugins: {
        [`fetched-plugin@${OFFICIAL_MARKETPLACE_NAME}`]: {
          unique_installs: 99,
          marketplace_entry: {
            name: "fetched-plugin",
            description: "from network",
            source: { source: "github", repo: "example/fetched" },
          },
        },
        "ignored@other-market": {
          unique_installs: 1,
          marketplace_entry: {
            name: "ignored",
            source: { source: "github", repo: "example/ignored" },
          },
        },
      },
    };
    const catalog = await refreshOfficialCatalog({
      fetchImpl: (async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    expect(catalog).not.toBeNull();
    expect(getInstallCountsSync().get(`fetched-plugin@${OFFICIAL_MARKETPLACE_NAME}`)).toBe(99);
    expect(getInstallCountsSync().has("ignored@other-market")).toBe(false);

    // Live catalog marketplace_entry must not become the Discover entry source.
    _forceOfficialCheckoutFailedForTesting();
    const listed = listMarketplacePlugins(OFFICIAL_MARKETPLACE_NAME);
    expect(listed.some((entry) => entry.name === "fetched-plugin")).toBe(false);
    expect(listed.length).toBeGreaterThan(10);
  });
});
