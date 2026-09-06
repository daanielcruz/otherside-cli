import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const PLUGIN_INSTALL_SCOPES = ["user", "project", "local"] as const;

export type PluginInstallScope = (typeof PLUGIN_INSTALL_SCOPES)[number];
export type PluginId = string;
export type InstallationId = string;

export interface ParsedPluginId {
  name: string;
  marketplace: string;
}

export interface ParsedInstallationId extends ParsedPluginId {
  scope: PluginInstallScope;
  projectPath?: string;
}

const SCOPE_SET: ReadonlySet<string> = new Set(PLUGIN_INSTALL_SCOPES);

export class PluginIdentityError extends Error {
  readonly code = "PLUGIN_IDENTITY_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "PluginIdentityError";
  }
}

function identityPart(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new PluginIdentityError(`Invalid plugin ${label}: ${JSON.stringify(value)}`);
  }
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.includes("@") ||
    normalized.includes(":") ||
    normalized.includes("\0")
  ) {
    throw new PluginIdentityError(`Invalid plugin ${label}: ${JSON.stringify(value)}`);
  }
  return normalized;
}

export function createPluginId(name: string, marketplace: string): PluginId {
  const pluginName = identityPart(name, "name");
  const marketplaceName = identityPart(marketplace, "marketplace");
  return `${pluginName}@${marketplaceName}` as PluginId;
}

export function parsePluginId(value: unknown): ParsedPluginId | undefined {
  if (typeof value !== "string") return undefined;
  const separator = value.indexOf("@");
  if (separator <= 0 || separator !== value.lastIndexOf("@")) return undefined;
  const name = value.slice(0, separator);
  const marketplace = value.slice(separator + 1);
  if (
    !name ||
    !marketplace ||
    name !== name.trim() ||
    marketplace !== marketplace.trim() ||
    name.includes(":") ||
    marketplace.includes(":") ||
    name.includes("\0") ||
    marketplace.includes("\0")
  )
    return undefined;
  return { name, marketplace };
}

export function isPluginId(value: unknown): boolean {
  return parsePluginId(value) !== undefined;
}

function canonicalizeExistingAncestor(projectPath: string): string {
  const missing: string[] = [];
  let candidate = projectPath;
  while (!realpathSyncSafe(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) break;
    missing.unshift(candidate.slice(parent.length + 1));
    candidate = parent;
  }
  const canonicalAncestor = realpathSyncSafe(candidate) ?? resolve(candidate);
  return missing.reduce((current, segment) => resolve(current, segment), canonicalAncestor);
}

function realpathSyncSafe(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

export function canonicalProjectPath(projectPath: string | undefined): string | undefined {
  if (projectPath === undefined) return undefined;
  if (
    typeof projectPath !== "string" ||
    projectPath.trim().length === 0 ||
    projectPath !== projectPath.trim()
  ) {
    throw new PluginIdentityError("Project path must be a non-empty string");
  }
  return canonicalizeExistingAncestor(resolve(projectPath));
}

export function createInstallationId(
  pluginId: PluginId | string,
  scope: PluginInstallScope,
  projectPath?: string,
): InstallationId {
  const parsed = parsePluginId(pluginId);
  if (!parsed) throw new PluginIdentityError(`Invalid plugin id: ${JSON.stringify(pluginId)}`);
  if (!SCOPE_SET.has(scope)) throw new PluginIdentityError(`Invalid plugin scope: ${scope}`);
  const normalizedProjectPath = canonicalProjectPath(projectPath);
  if (scope === "user" && normalizedProjectPath !== undefined) {
    throw new PluginIdentityError("User-scope installations cannot have a project path");
  }
  if ((scope === "project" || scope === "local") && normalizedProjectPath === undefined) {
    throw new PluginIdentityError(`Project path is required for ${scope}-scope installations`);
  }
  const canonicalPluginId = createPluginId(parsed.name, parsed.marketplace);
  return `${canonicalPluginId}:${scope}:${normalizedProjectPath ?? ""}` as InstallationId;
}

export function parseInstallationId(value: unknown): ParsedInstallationId | undefined {
  if (typeof value !== "string") return undefined;
  const firstSeparator = value.indexOf(":");
  const secondSeparator = value.indexOf(":", firstSeparator + 1);
  if (firstSeparator <= 0 || secondSeparator <= firstSeparator) return undefined;
  const pluginId = value.slice(0, firstSeparator);
  const scope = value.slice(firstSeparator + 1, secondSeparator);
  const projectPath = value.slice(secondSeparator + 1);
  const parsedPlugin = parsePluginId(pluginId);
  if (!parsedPlugin || !SCOPE_SET.has(scope)) return undefined;
  try {
    const normalizedProjectPath = canonicalProjectPath(projectPath || undefined);
    if (scope === "user" && normalizedProjectPath !== undefined) return undefined;
    if ((scope === "project" || scope === "local") && normalizedProjectPath === undefined) {
      return undefined;
    }
    const canonical = createInstallationId(
      createPluginId(parsedPlugin.name, parsedPlugin.marketplace),
      scope as PluginInstallScope,
      normalizedProjectPath,
    );
    if (canonical !== value) return undefined;
    return {
      ...parsedPlugin,
      scope: scope as PluginInstallScope,
      ...(normalizedProjectPath === undefined ? {} : { projectPath: normalizedProjectPath }),
    };
  } catch {
    return undefined;
  }
}

export function isInstallationId(value: unknown): value is InstallationId {
  return parseInstallationId(value) !== undefined;
}
