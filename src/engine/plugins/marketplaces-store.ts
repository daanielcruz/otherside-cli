import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { withFileLockSync } from "@/kernel/std/fs/file-lock.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { atomicWriteFileSync } from "@/kernel/std/fs/secure-fs.ts";

export type MarketplaceSourceType = "git" | "github" | "file";

export interface KnownMarketplace {
  name: string;
  source: string;
  sourceType: MarketplaceSourceType;
  installLocation: string;
  lastUpdated: string;
  builtIn?: boolean;
}

/** Fixed-pointer official marketplace name (parity with claude-code). */
export const OFFICIAL_MARKETPLACE_NAME = "claude-plugins-official";
/** Fixed-pointer github source for the official marketplace (parity). */
export const OFFICIAL_MARKETPLACE_SOURCE = "anthropics/claude-plugins-official";

function officialMarketplace(lastUpdated = "1970-01-01T00:00:00.000Z"): KnownMarketplace {
  return {
    name: OFFICIAL_MARKETPLACE_NAME,
    source: OFFICIAL_MARKETPLACE_SOURCE,
    sourceType: "github",
    installLocation: join(configRoot(), "plugins", "marketplaces", OFFICIAL_MARKETPLACE_NAME),
    lastUpdated,
    builtIn: true,
  };
}

function marketplacesPath(): string {
  return join(configRoot(), "plugins", "marketplaces.json");
}

function readAll(): KnownMarketplace[] {
  const path = marketplacesPath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as KnownMarketplace[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function updateAll(
  update: (entries: KnownMarketplace[]) => KnownMarketplace[],
): KnownMarketplace[] {
  const path = marketplacesPath();
  mkdirSync(dirname(path), { recursive: true });
  return withFileLockSync(path, () => {
    const entries = update(readAll());
    atomicWriteFileSync(path, `${JSON.stringify(entries, null, 2)}\n`);
    return entries;
  });
}

export function listKnownMarketplaces(): KnownMarketplace[] {
  return readAll();
}

export function listAvailableMarketplaces(): KnownMarketplace[] {
  const configured = readAll();
  const configuredOfficial = configured.find((entry) => entry.name === OFFICIAL_MARKETPLACE_NAME);
  return [
    officialMarketplace(configuredOfficial?.lastUpdated),
    ...configured.filter((entry) => entry.name !== OFFICIAL_MARKETPLACE_NAME),
  ];
}

export function getKnownMarketplace(name: string): KnownMarketplace | undefined {
  return listAvailableMarketplaces().find((m) => m.name === name);
}

export function addKnownMarketplace(entry: KnownMarketplace): void {
  updateAll((entries) => {
    const next = entries.filter((m) => m.name !== entry.name);
    next.push({ ...entry, lastUpdated: new Date().toISOString() });
    return next;
  });
}

function isManagedCachePath(path: string): boolean {
  const root = resolve(configRoot(), "plugins", "marketplaces");
  const rel = relative(root, resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function removeKnownMarketplace(name: string): boolean {
  let removed: KnownMarketplace | undefined;
  updateAll((entries) => {
    removed = entries.find((entry) => entry.name === name);
    return removed ? entries.filter((entry) => entry.name !== name) : entries;
  });
  if (!removed) return false;
  if (
    removed.sourceType !== "file" &&
    removed.installLocation &&
    isManagedCachePath(removed.installLocation)
  ) {
    rmSync(removed.installLocation, { recursive: true, force: true });
  }
  return true;
}
