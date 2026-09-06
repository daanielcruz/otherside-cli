import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HookEvent } from "@/kernel/hooks/events.ts";
import { HOOK_EVENT_VALUES } from "@/kernel/hooks/events.ts";
import type { HookEntry } from "@/kernel/std/types/hook-entry.ts";
import { isFile, isWithinRoot, readJsonFile } from "./component-files.ts";
import type { PluginManifest } from "./manifest.ts";

export type HooksSettings = Partial<Record<HookEvent, HookEntry[]>>;

function getNormalizedEventKey(eventKey: string): HookEvent | null {
  if (typeof eventKey !== "string") return null;
  const validEvents: ReadonlySet<string> = new Set(HOOK_EVENT_VALUES);
  if (validEvents.has(eventKey)) {
    return eventKey as HookEvent;
  }
  if (eventKey === "notification") {
    return "Notification";
  }
  const normalized = eventKey.charAt(0).toLowerCase() + eventKey.slice(1);
  if (validEvents.has(normalized)) {
    return normalized as HookEvent;
  }
  return null;
}

type RawHookCommand = {
  type?: string;
  command?: string;
  args?: unknown[];
  prompt?: string;
  timeout?: number;
  model?: string;
  url?: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
};

function normalizeHookEntry(
  entry: RawHookCommand,
  matcher: string,
  pluginRoot: string,
): HookEntry | null {
  const type = entry.type;
  if (type === "mcp_tool") return null;

  const timeout = typeof entry.timeout === "number" ? entry.timeout : undefined;

  if (type === "prompt") {
    if (typeof entry.prompt !== "string") return null;
    return {
      type,
      matcher,
      prompt: entry.prompt,
      ...(timeout !== undefined ? { timeout } : {}),
    };
  }

  if (type === "agent") {
    if (typeof entry.prompt !== "string") return null;
    return {
      type,
      matcher,
      prompt: entry.prompt,
      command: entry.prompt,
      ...(timeout !== undefined ? { timeout } : {}),
      ...(typeof entry.model === "string" ? { model: entry.model } : {}),
    };
  }

  if (type === "http") {
    if (typeof entry.url !== "string") return null;
    return {
      type,
      matcher,
      url: entry.url,
      command: entry.url,
      ...(timeout !== undefined ? { timeout } : {}),
      ...(entry.headers !== undefined ? { headers: entry.headers } : {}),
      ...(entry.allowedEnvVars !== undefined ? { allowedEnvVars: entry.allowedEnvVars } : {}),
    };
  }

  if (typeof entry.command !== "string") return null;
  let finalCommand = entry.command;
  if (Array.isArray(entry.args)) {
    finalCommand = [entry.command, ...entry.args].join(" ");
  }

  return {
    type: "command",
    matcher,
    command: finalCommand,
    pluginRoot,
    ...(timeout !== undefined ? { timeout } : {}),
  };
}

export function normalizePluginHooks(raw: unknown, pluginRoot: string): HooksSettings {
  if (typeof raw === "string") {
    const targetPath = resolve(pluginRoot, raw);
    if (!isWithinRoot(pluginRoot, targetPath)) {
      return {};
    }
    if (!isFile(targetPath)) {
      return {};
    }
    try {
      const fileContent = readFileSync(targetPath, "utf8");
      let parsed = JSON.parse(fileContent);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (
          "hooks" in parsed &&
          parsed.hooks &&
          typeof parsed.hooks === "object" &&
          !Array.isArray(parsed.hooks)
        ) {
          parsed = parsed.hooks;
        }
      }
      return normalizePluginHooks(parsed, pluginRoot);
    } catch {
      return {};
    }
  }

  if (Array.isArray(raw)) {
    const merged: HooksSettings = {};
    for (const item of raw) {
      const itemSettings = normalizePluginHooks(item, pluginRoot);
      for (const [evt, entries] of Object.entries(itemSettings)) {
        const eventKey = evt as HookEvent;
        if (entries) {
          if (!merged[eventKey]) {
            merged[eventKey] = [];
          }
          merged[eventKey]!.push(...entries);
        }
      }
    }
    return merged;
  }

  if (typeof raw === "object" && raw !== null) {
    const settings: HooksSettings = {};
    for (const [eventKey, entries] of Object.entries(raw)) {
      const normalizedEvent = getNormalizedEventKey(eventKey);
      if (!normalizedEvent) continue;

      if (!Array.isArray(entries)) continue;

      const normalizedEntries: HookEntry[] = [];
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;

        if ("hooks" in entry && Array.isArray(entry.hooks)) {
          const outerMatcher = typeof entry.matcher === "string" ? entry.matcher : "*";
          for (const inner of entry.hooks) {
            if (!inner || typeof inner !== "object") continue;
            const normalized = normalizeHookEntry(inner, outerMatcher, pluginRoot);
            if (normalized) {
              normalizedEntries.push(normalized);
            }
          }
        } else {
          const matcher = typeof entry.matcher === "string" ? entry.matcher : "*";
          const normalized = normalizeHookEntry(entry, matcher, pluginRoot);
          if (normalized) {
            normalizedEntries.push(normalized);
          }
        }
      }

      if (normalizedEntries.length > 0) {
        if (!settings[normalizedEvent]) {
          settings[normalizedEvent] = [];
        }
        settings[normalizedEvent]!.push(...normalizedEntries);
      }
    }
    return settings;
  }

  return {};
}

/** Merge hooks.json settings with manifest-declared hooks, json entries first. */
export function loadHooks(
  manifest: PluginManifest,
  hooksDir: string,
  root: string,
): HooksSettings | null {
  let hooksJsonSettings: HooksSettings | null = null;
  const hooksJsonPath = join(hooksDir, "hooks.json");
  const hasHooksJson = isWithinRoot(root, hooksJsonPath) && isFile(hooksJsonPath);
  if (hasHooksJson) {
    try {
      const raw = readJsonFile(hooksJsonPath);
      let parsed = raw;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (
          "hooks" in parsed &&
          parsed.hooks &&
          typeof parsed.hooks === "object" &&
          !Array.isArray(parsed.hooks)
        ) {
          parsed = parsed.hooks;
        }
      }
      hooksJsonSettings = normalizePluginHooks(parsed, root);
    } catch {}
  }

  let manifestSettings: HooksSettings | null = null;
  const hasManifestHooks = manifest.hooks !== undefined;
  if (hasManifestHooks) {
    manifestSettings = normalizePluginHooks(manifest.hooks, root);
  }

  if (!hasHooksJson && !hasManifestHooks) {
    return null;
  }

  const merged: HooksSettings = {};
  const allEvents = new Set<HookEvent>([
    ...(hooksJsonSettings ? (Object.keys(hooksJsonSettings) as HookEvent[]) : []),
    ...(manifestSettings ? (Object.keys(manifestSettings) as HookEvent[]) : []),
  ]);

  for (const event of allEvents) {
    const list1 = hooksJsonSettings?.[event] ?? [];
    const list2 = manifestSettings?.[event] ?? [];
    const combined = [...list1, ...list2];
    if (combined.length > 0) {
      merged[event] = combined;
    }
  }

  return merged;
}
