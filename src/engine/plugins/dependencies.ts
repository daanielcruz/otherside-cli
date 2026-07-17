import { createPluginId, parsePluginId } from "./identity.ts";
import type { LoadedPlugin } from "./loader.ts";
import * as plugins from "./registry.ts";

export interface DependencyPlugin {
  pluginId: string;
  plugin: LoadedPlugin;
  enabled: boolean;
}

/**
 * Qualify a manifest dependency entry against the declaring plugin. A bare
 * name inherits the declarer's marketplace; a `name@marketplace` entry stays
 * as written.
 */
export function qualifyDependency(dependency: string, declaringId: string): string {
  if (parsePluginId(dependency)) return dependency;
  const declarer = parsePluginId(declaringId);
  if (!declarer) return dependency;
  return createPluginId(dependency, declarer.marketplace);
}

function dependencyMatches(entry: string, declaringId: string, targetId: string): boolean {
  const qualified = qualifyDependency(entry, declaringId);
  if (qualified === targetId) return true;
  // A bare-name dependency also matches any installed plugin with that name.
  if (!parsePluginId(entry)) {
    const target = parsePluginId(targetId);
    if (target && target.name === entry) return true;
  }
  return false;
}

/** Enabled plugins (excluding the target) whose manifest requires the target. */
export function reverseDependents(targetId: string, all: readonly DependencyPlugin[]): string[] {
  return all
    .filter(
      (candidate) =>
        candidate.enabled &&
        candidate.pluginId !== targetId &&
        (candidate.plugin.manifest.dependencies ?? []).some((entry) =>
          dependencyMatches(entry, candidate.pluginId, targetId),
        ),
    )
    .map((candidate) => candidate.plugin.manifest.name);
}

/**
 * Transitive dependency closure of the target across the installed set.
 * Returns the installed dependency ids (deduped, target excluded) and the
 * entries that resolve to nothing installed.
 */
export function dependencyClosure(
  targetId: string,
  all: readonly DependencyPlugin[],
): { closure: string[]; missing: string[] } {
  const byId = new Map(all.map((entry) => [entry.pluginId, entry]));
  const byName = new Map(all.map((entry) => [entry.plugin.manifest.name, entry]));
  const resolve = (id: string): DependencyPlugin | undefined => {
    const exact = byId.get(id);
    if (exact) return exact;
    return parsePluginId(id) ? undefined : byName.get(id);
  };
  const seen = new Set<string>([targetId]);
  const closure: string[] = [];
  const missing: string[] = [];
  const queue = (resolve(targetId)?.plugin.manifest.dependencies ?? []).map((entry) => ({
    entry,
    declaringId: targetId,
  }));
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const qualified = qualifyDependency(item.entry, item.declaringId);
    const resolved = resolve(qualified) ?? resolve(item.entry);
    if (!resolved) {
      if (!seen.has(qualified)) {
        seen.add(qualified);
        missing.push(qualified);
      }
      continue;
    }
    if (seen.has(resolved.pluginId)) continue;
    seen.add(resolved.pluginId);
    closure.push(resolved.pluginId);
    for (const entry of resolved.plugin.manifest.dependencies ?? []) {
      queue.push({ entry, declaringId: resolved.pluginId });
    }
  }
  return { closure, missing };
}

/** Registry-backed view of every loaded plugin with its enabled setting. */
export function registryDependencyPlugins(): DependencyPlugin[] {
  return plugins.list().map(({ pluginId, plugin }) => ({
    pluginId,
    plugin,
    enabled: plugins.isEnabledSetting(pluginId),
  }));
}

export function requiredByWarning(dependents: readonly string[]): string {
  if (dependents.length === 0) return "";
  return ` — warning: required by ${dependents.join(", ")}`;
}

export interface EnabledChangeResult {
  success: boolean;
  message: string;
  reverseDependents?: string[];
}

/**
 * Enable/disable a plugin with dependency semantics: disabling is blocked
 * while enabled plugins still require the target; enabling also enables the
 * target's installed dependency closure.
 */
export async function changeEnabledWithDependencies(
  target: string,
  enabled: boolean,
): Promise<EnabledChangeResult> {
  const resolved = plugins.resolvePlugin(target);
  const pluginId = resolved.ok ? resolved.pluginId : target;
  const name = parsePluginId(pluginId)?.name ?? pluginId;
  const all = registryDependencyPlugins();

  if (!enabled) {
    const dependents = reverseDependents(pluginId, all);
    if (dependents.length > 0) {
      return {
        success: false,
        message: `${name} is still required by ${dependents.join(", ")}. Disable ${
          dependents.length === 1 ? "that plugin" : "those plugins"
        } first, or disable them together in /plugins.`,
        reverseDependents: dependents,
      };
    }
    const changed = await plugins.setEnabled(pluginId, false);
    return changed
      ? { success: true, message: `Disabled plugin ${pluginId}. Run /reload to apply.` }
      : { success: false, message: `Plugin not found: ${target}` };
  }

  const { closure } = dependencyClosure(pluginId, all);
  const toEnable = closure.filter((id) => {
    const entry = all.find((candidate) => candidate.pluginId === id);
    return entry !== undefined && !entry.enabled;
  });
  const changed = await plugins.setEnabled(pluginId, true);
  if (!changed) return { success: false, message: `Plugin not found: ${target}` };
  for (const id of toEnable) await plugins.setEnabled(id, true);
  const suffix =
    toEnable.length > 0
      ? ` (also enabled ${toEnable.length} ${toEnable.length === 1 ? "dependency" : "dependencies"}: ${toEnable
          .map((id) => parsePluginId(id)?.name ?? id)
          .join(", ")})`
      : "";
  return {
    success: true,
    message: `Enabled plugin ${pluginId}${suffix}. Run /reload to apply.`,
  };
}
