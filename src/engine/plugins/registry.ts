import { loadConfigSync, updateConfig } from "@/kernel/config/config.ts";
import type { HookEvent } from "@/kernel/hooks/events.ts";
import { handlersFromHookMap, registerHookEntryProvider } from "@/kernel/hooks/handler.ts";
import type { HookHandler } from "@/kernel/hooks/index.ts";
import type { HookEntry } from "@/kernel/std/types/hook-entry.ts";
import { createPluginId, isPluginId, type PluginId, parsePluginId } from "./identity.ts";
import { findPluginInstallationByPath } from "./installations.ts";
import type { LoadedPlugin } from "./loader.ts";
import { replaceDesiredState } from "./state.ts";

const registry = new Map<PluginId, LoadedPlugin>();
const desiredDisabledPlugins = new Set<PluginId>();
const runtimeDisabledPlugins = new Set<PluginId>();

export interface PluginRegistryEntry {
  readonly pluginId: PluginId;
  readonly plugin: LoadedPlugin;
}

export interface PluginRegistrySnapshot {
  readonly entries: readonly PluginRegistryEntry[];
  readonly desiredDisabled: readonly PluginId[];
  readonly runtimeDisabled: readonly PluginId[];
}

export type RegisteredPluginLookup =
  | { ok: true; plugin: LoadedPlugin; pluginId: PluginId }
  | {
      ok: false;
      code: "PLUGIN_NOT_FOUND" | "PLUGIN_AMBIGUOUS";
      target: string;
      candidates: readonly PluginId[];
    };

export function pluginIdForPlugin(plugin: LoadedPlugin): PluginId {
  const installation = findPluginInstallationByPath(plugin.path);
  if (installation) return installation.identity;
  if (isPluginId(plugin.source)) return plugin.source;
  const marketplace =
    plugin.source.trim() && !plugin.source.includes("/") ? plugin.source : "local";
  return createPluginId(plugin.name, marketplace);
}

export function register(plugin: LoadedPlugin): PluginId {
  const pluginId = pluginIdForPlugin(plugin);
  registry.set(pluginId, plugin);
  return pluginId;
}

export function snapshot(): PluginRegistrySnapshot {
  return {
    entries: list(),
    desiredDisabled: [...desiredDisabledPlugins].sort(),
    runtimeDisabled: [...runtimeDisabledPlugins].sort(),
  };
}

export function replaceSnapshot(next: PluginRegistrySnapshot): void {
  registry.clear();
  desiredDisabledPlugins.clear();
  runtimeDisabledPlugins.clear();
  for (const { pluginId, plugin } of next.entries) registry.set(pluginId, plugin);
  for (const pluginId of next.desiredDisabled) desiredDisabledPlugins.add(pluginId);
  for (const pluginId of next.runtimeDisabled) runtimeDisabledPlugins.add(pluginId);
}

function lookupFailure(
  target: string,
  code: "PLUGIN_NOT_FOUND" | "PLUGIN_AMBIGUOUS",
  candidates: readonly PluginId[] = [],
): RegisteredPluginLookup {
  return { ok: false, code, target, candidates };
}

export function lookup(target: string): RegisteredPluginLookup {
  if (isPluginId(target)) {
    const plugin = registry.get(target);
    return plugin
      ? { ok: true, plugin, pluginId: target }
      : lookupFailure(target, "PLUGIN_NOT_FOUND");
  }
  if (target.includes("@")) return lookupFailure(target, "PLUGIN_NOT_FOUND");
  const candidates = [...registry.entries()]
    .filter(([, plugin]) => plugin.name === target)
    .map(([pluginId]) => pluginId)
    .sort();
  if (candidates.length === 0) return lookupFailure(target, "PLUGIN_NOT_FOUND");
  if (candidates.length !== 1) return lookupFailure(target, "PLUGIN_AMBIGUOUS", candidates);
  const pluginId = candidates[0]!;
  return { ok: true, plugin: registry.get(pluginId)!, pluginId };
}

export function resolvePlugin(target: string): RegisteredPluginLookup {
  return lookup(target);
}

export function unregister(target: string): void {
  const result = lookup(target);
  if (!result.ok) return;
  registry.delete(result.pluginId);
  desiredDisabledPlugins.delete(result.pluginId);
  runtimeDisabledPlugins.delete(result.pluginId);
}

export function restore(pluginId: PluginId, plugin: LoadedPlugin | undefined): void {
  if (plugin === undefined) registry.delete(pluginId);
  else registry.set(pluginId, plugin);
}

export function get(target: string): LoadedPlugin | undefined {
  const result = lookup(target);
  return result.ok ? result.plugin : undefined;
}

export function list(): PluginRegistryEntry[] {
  return [...registry.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([pluginId, plugin]) => ({ pluginId, plugin }));
}

export function clear(): void {
  registry.clear();
  desiredDisabledPlugins.clear();
  runtimeDisabledPlugins.clear();
}

export function isEnabled(target: string): boolean {
  const result = lookup(target);
  return result.ok && !desiredDisabledPlugins.has(result.pluginId);
}

/**
 * Desired enabled state independent of load state. A disk installation still
 * pending /reload has no registry entry; its enabled state is the
 * persisted setting (absent means enabled).
 */
export function isEnabledSetting(target: string): boolean {
  const result = lookup(target);
  if (result.ok) return !desiredDisabledPlugins.has(result.pluginId);
  if (!isPluginId(target)) return false;
  return loadConfigSync().enabledPlugins?.[target] !== false;
}

export function isRuntimeEnabled(target: string): boolean {
  const result = lookup(target);
  return result.ok && !runtimeDisabledPlugins.has(result.pluginId);
}

export interface PluginEnabledStateDiagnostic {
  readonly code: "PLUGIN_AMBIGUOUS";
  readonly target: string;
  readonly candidates: readonly PluginId[];
}

function desiredStateFromPersisted(persisted: Record<string, boolean> | undefined): {
  enabled: string[];
  disabled: string[];
} {
  const enabled: string[] = [];
  const disabled: string[] = [];
  for (const [pluginId, value] of Object.entries(persisted ?? {})) {
    (value ? enabled : disabled).push(pluginId);
  }
  enabled.sort();
  disabled.sort();
  return { enabled, disabled };
}

function removeLegacyName(enabledPlugins: Record<string, boolean>, plugin: LoadedPlugin): void {
  delete enabledPlugins[plugin.name];
}

function removeLegacyNameForId(enabledPlugins: Record<string, boolean>, pluginId: PluginId): void {
  const parsed = parsePluginId(pluginId);
  if (parsed) delete enabledPlugins[parsed.name];
}

export async function setEnabled(target: string, enabled: boolean): Promise<boolean> {
  const result = lookup(target);
  const fallbackId = !result.ok && isPluginId(target) ? target : undefined;
  if (!result.ok && fallbackId === undefined) return false;
  const plugin = result.ok ? result.plugin : undefined;
  const pluginId = result.ok ? result.pluginId : fallbackId!;
  const config = await updateConfig((cfg) => {
    const enabledPlugins = { ...(cfg.enabledPlugins ?? {}), [pluginId]: enabled };
    if (plugin) removeLegacyName(enabledPlugins, plugin);
    else removeLegacyNameForId(enabledPlugins, pluginId);
    enabledPlugins[pluginId] = enabled;
    cfg.enabledPlugins = enabledPlugins;
  });
  if (enabled) desiredDisabledPlugins.delete(pluginId);
  else desiredDisabledPlugins.add(pluginId);
  replaceDesiredState(desiredStateFromPersisted(config.enabledPlugins));
  return true;
}

export async function clearEnabledSetting(target: string): Promise<void> {
  const result = lookup(target);
  const fallbackId = !result.ok && isPluginId(target) ? target : undefined;
  if (!result.ok && fallbackId === undefined) return;
  const plugin = result.ok ? result.plugin : undefined;
  const pluginId = result.ok ? result.pluginId : fallbackId!;
  const config = await updateConfig((cfg) => {
    if (!cfg.enabledPlugins) return;
    const enabledPlugins = { ...cfg.enabledPlugins };
    delete enabledPlugins[pluginId];
    if (plugin) removeLegacyName(enabledPlugins, plugin);
    else removeLegacyNameForId(enabledPlugins, pluginId);
    cfg.enabledPlugins = enabledPlugins;
  });
  desiredDisabledPlugins.delete(pluginId);
  replaceDesiredState(desiredStateFromPersisted(config.enabledPlugins));
}

export function applyPersistedEnabledState(
  persisted: Record<string, boolean> | undefined,
): PluginEnabledStateDiagnostic[] {
  desiredDisabledPlugins.clear();
  runtimeDisabledPlugins.clear();

  const diagnostics: PluginEnabledStateDiagnostic[] = [];
  const canonicalKeys = new Set(Object.keys(persisted ?? {}));
  for (const pluginId of registry.keys()) {
    if (!canonicalKeys.has(pluginId)) continue;
    if (persisted?.[pluginId] !== false) continue;
    desiredDisabledPlugins.add(pluginId);
    runtimeDisabledPlugins.add(pluginId);
  }

  for (const [target, value] of Object.entries(persisted ?? {})) {
    if (target.includes("@")) continue;
    const result = lookup(target);
    if (!result.ok) {
      if (result.code === "PLUGIN_AMBIGUOUS") {
        diagnostics.push({
          code: "PLUGIN_AMBIGUOUS",
          target,
          candidates: [...result.candidates].sort(),
        });
      }
      continue;
    }
    if (canonicalKeys.has(result.pluginId)) continue;
    if (value !== false) continue;
    desiredDisabledPlugins.add(result.pluginId);
    runtimeDisabledPlugins.add(result.pluginId);
  }

  diagnostics.sort((left, right) => left.target.localeCompare(right.target));
  return diagnostics;
}

function namespaceHookEntries(pluginId: PluginId, entries: readonly HookEntry[]): HookEntry[] {
  return entries.map((entry) => ({ ...entry, pluginId }) as unknown as HookEntry);
}

export function listEnabledHookHandlers(): HookHandler[] {
  const handlers: HookHandler[] = [];
  for (const [pluginId, plugin] of registry) {
    if (runtimeDisabledPlugins.has(pluginId)) continue;
    if (plugin.hooksConfig) {
      const namespaced = Object.fromEntries(
        Object.entries(plugin.hooksConfig).map(([event, entries]) => [
          event,
          namespaceHookEntries(pluginId, entries ?? []),
        ]),
      ) as typeof plugin.hooksConfig;
      handlers.push(...handlersFromHookMap(namespaced));
    }
  }
  return handlers;
}

export function listEnabledHookEntries(event: HookEvent): HookEntry[] {
  const entries: HookEntry[] = [];
  for (const [pluginId, plugin] of registry) {
    if (runtimeDisabledPlugins.has(pluginId)) continue;
    if (plugin.hooksConfig?.[event]) {
      entries.push(...namespaceHookEntries(pluginId, plugin.hooksConfig[event]!));
    }
  }
  return entries;
}

registerHookEntryProvider(listEnabledHookEntries);
