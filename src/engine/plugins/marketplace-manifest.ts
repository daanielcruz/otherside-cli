import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { MarketplaceSourceType } from "./marketplaces-store.ts";

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
  homepage?: string;
  lastUpdated?: string;
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

export const GITHUB_REPO_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

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
    if (typeof e.homepage === "string") item.homepage = e.homepage;
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

export function githubUrl(repo: string): string {
  return repo.startsWith("https://") ? repo : `https://github.com/${repo}.git`;
}

export function cloneTargetFor(source: string): { url?: string } {
  const type = detectSourceType(source);
  if (type === "github") return { url: githubUrl(source) };
  if (type === "git") return { url: source };
  return {};
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(canonicalPath(root), canonicalPath(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolve a manifest-relative file source, refusing paths that escape the marketplace. */
export function resolveFileSource(
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
