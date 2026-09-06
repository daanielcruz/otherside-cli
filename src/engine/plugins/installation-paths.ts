import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { canonicalProjectPath, type PluginInstallScope } from "./identity.ts";
import { PluginMigrationError } from "./installation-records.ts";

export function validateInstallPath(
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

export function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(canonicalPath(root), canonicalPath(target));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isWithinLexicalRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
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
    const normalizedProjectPath = canonicalProjectPath(projectPath);
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
  const normalizedProjectPath = canonicalProjectPath(projectPath);
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
