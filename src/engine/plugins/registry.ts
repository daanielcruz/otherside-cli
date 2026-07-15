import { updateConfig } from "@/kernel/config/config.ts";
import type { HookEvent } from "@/kernel/hooks/events.ts";
import type { HookEntry } from "@/kernel/hooks/exec.ts";
import { handlersFromHookMap, registerHookEntryProvider } from "@/kernel/hooks/handler.ts";
import type { HookHandler } from "@/kernel/hooks/index.ts";
import { findPluginInstallation, pluginIdentity } from "./installations.ts";
import type { LoadedPlugin } from "./loader.ts";

const registry = new Map<string, LoadedPlugin>();
const desiredDisabledPlugins = new Set<string>();
const runtimeDisabledPlugins = new Set<string>();

export function register(plugin: LoadedPlugin): void {
  registry.set(plugin.name, plugin);
}

export function unregister(target: string): void {
  const name = findPluginInstallation(target)?.pluginName ?? target.split("@")[0] ?? target;
  registry.delete(name);
  desiredDisabledPlugins.delete(name);
  runtimeDisabledPlugins.delete(name);
}

function pluginNameFor(target: string): string {
  return findPluginInstallation(target)?.pluginName ?? target.split("@")[0] ?? target;
}

export function get(target: string): LoadedPlugin | undefined {
  return registry.get(pluginNameFor(target));
}

export function list(): LoadedPlugin[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function clear(): void {
  registry.clear();
  desiredDisabledPlugins.clear();
  runtimeDisabledPlugins.clear();
}

export function isEnabled(target: string): boolean {
  const name = pluginNameFor(target);
  return registry.has(name) && !desiredDisabledPlugins.has(name);
}

export function isRuntimeEnabled(target: string): boolean {
  const name = pluginNameFor(target);
  return registry.has(name) && !runtimeDisabledPlugins.has(name);
}

export async function setEnabled(target: string, enabled: boolean): Promise<boolean> {
  const name = pluginNameFor(target);
  if (!registry.has(name)) return false;
  if (enabled) {
    desiredDisabledPlugins.delete(name);
  } else {
    desiredDisabledPlugins.add(name);
  }
  const identity = pluginIdentity(name);
  await updateConfig((cfg) => {
    const next = { ...cfg.enabledPlugins, [identity]: enabled };
    if (identity !== name) delete next[name];
    cfg.enabledPlugins = next;
  });
  return true;
}

export async function clearEnabledSetting(target: string): Promise<void> {
  const installation = findPluginInstallation(target);
  const name = installation?.pluginName ?? pluginNameFor(target);
  const identity = installation?.identity ?? target;
  await updateConfig((cfg) => {
    if (!cfg.enabledPlugins) return;
    const next = { ...cfg.enabledPlugins };
    delete next[identity];
    delete next[name];
    cfg.enabledPlugins = next;
  });
}

export function applyPersistedEnabledState(persisted: Record<string, boolean> | undefined): void {
  for (const plugin of registry.values()) {
    const identity = pluginIdentity(plugin.name);
    const enabled = persisted?.[identity] ?? persisted?.[plugin.name] ?? true;
    if (enabled) {
      desiredDisabledPlugins.delete(plugin.name);
      runtimeDisabledPlugins.delete(plugin.name);
    } else {
      desiredDisabledPlugins.add(plugin.name);
      runtimeDisabledPlugins.add(plugin.name);
    }
  }
}

export function listEnabledHookHandlers(): HookHandler[] {
  const handlers: HookHandler[] = [];
  for (const plugin of registry.values()) {
    if (!isRuntimeEnabled(plugin.name)) continue;
    if (plugin.hooksConfig) {
      handlers.push(...handlersFromHookMap(plugin.hooksConfig));
    }
  }
  return handlers;
}

export function listEnabledHookEntries(event: HookEvent): HookEntry[] {
  const entries: HookEntry[] = [];
  for (const plugin of registry.values()) {
    if (!isRuntimeEnabled(plugin.name)) continue;
    if (plugin.hooksConfig?.[event]) {
      entries.push(...plugin.hooksConfig[event]!);
    }
  }
  return entries;
}

registerHookEntryProvider(listEnabledHookEntries);
