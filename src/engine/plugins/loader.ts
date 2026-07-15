import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HookEvent } from "@/kernel/hooks/events.ts";
import { HOOK_EVENT_VALUES } from "@/kernel/hooks/events.ts";
import type { HookEntry } from "@/kernel/hooks/exec.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";
import { findPluginInstallationByPath, listPluginInstallations } from "./installations.ts";
import {
  type CommandMetadata,
  isNonCommandHookType,
  type PluginManifest,
  parseManifest,
} from "./manifest.ts";

export type HooksSettings = Partial<Record<HookEvent, HookEntry[]>>;

export interface LoadedPlugin {
  name: string;
  path: string;
  source: string;
  manifest: PluginManifest;
  commandsPath?: string;
  agentsPath?: string;
  skillsPath?: string;
  workflowsPath?: string;
  hooksConfig?: HooksSettings;
}

export interface ResolvedCommand {
  name: string;
  path: string;
  content: string;
  metadata?: CommandMetadata;
}

export interface ResolvedAgent {
  id: string;
  path: string;
  content: string;
}

export interface ResolvedSkill {
  name: string;
  path: string;
  content: string;
}

export interface ResolvedPlugin {
  plugin: LoadedPlugin;
  commands: ResolvedCommand[];
  agents: ResolvedAgent[];
  skills: ResolvedSkill[];
  hooks: HooksSettings | null;
}

export interface PluginLoadError {
  path: string;
  error: string;
}

export interface PluginLoadResult {
  plugins: LoadedPlugin[];
  errors: PluginLoadError[];
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isWithinRoot(root: string, target: string): boolean {
  const relativeTarget = relative(canonicalPath(root), canonicalPath(target));
  return (
    relativeTarget === "" ||
    (relativeTarget !== ".." &&
      !relativeTarget.startsWith(`..${sep}`) &&
      !isAbsolute(relativeTarget))
  );
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function existsAt(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function readJsonFile(p: string): unknown {
  const raw = readFileSync(p, "utf8");
  return JSON.parse(raw);
}

function resolveManifestPath(pluginDir: string): string | null {
  const nested = join(pluginDir, ".claude-plugin", "plugin.json");
  if (isFile(nested)) return nested;
  const flat = join(pluginDir, "plugin.json");
  if (isFile(flat)) return flat;
  return null;
}

function collectMdFiles(
  dir: string,
  root: string,
): { name: string; path: string; content: string }[] {
  if (!isDirectory(dir)) return [];
  const results: { name: string; path: string; content: string }[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(dir, entry);
    if (!isWithinRoot(root, filePath)) continue;
    if (!isFile(filePath)) continue;
    try {
      const content = readFileSync(filePath, "utf8");
      const name = entry.replace(/\.md$/, "");
      results.push({ name, path: filePath, content });
    } catch {}
  }
  return results;
}

function collectMdPath(
  path: string,
  root: string,
): { name: string; path: string; content: string }[] {
  const target = resolve(root, path);
  if (!isWithinRoot(root, target)) return [];
  if (isDirectory(target)) return collectMdFiles(target, root);
  if (!isFile(target) || extname(target).toLowerCase() !== ".md") return [];
  try {
    return [
      {
        name: basename(target, extname(target)),
        path: target,
        content: readFileSync(target, "utf8"),
      },
    ];
  } catch {
    return [];
  }
}

function collectSkillEntries(dir: string, root: string): ResolvedSkill[] {
  if (!isDirectory(dir)) return [];
  const results: ResolvedSkill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry);
    if (!isWithinRoot(root, entryPath)) continue;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(entryPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const skillFile = join(entryPath, "SKILL.md");
      if (!isWithinRoot(root, skillFile)) continue;
      try {
        const content = readFileSync(skillFile, "utf8");
        results.push({ name: entry, path: skillFile, content });
      } catch {}
    } else if (stat.isFile() && entry.endsWith(".md")) {
      try {
        const content = readFileSync(entryPath, "utf8");
        results.push({ name: entry.replace(/\.md$/, ""), path: entryPath, content });
      } catch {}
    }
  }
  return results;
}

function collectSkillPath(path: string, root: string): ResolvedSkill[] {
  const target = resolve(root, path);
  if (!isWithinRoot(root, target)) return [];
  if (isDirectory(target)) {
    const skillFile = join(target, "SKILL.md");
    if (isFile(skillFile)) {
      try {
        return [
          { name: basename(target), path: skillFile, content: readFileSync(skillFile, "utf8") },
        ];
      } catch {
        return [];
      }
    }
    return collectSkillEntries(target, root);
  }
  return collectMdPath(target, root).map((entry) => ({
    name: entry.name,
    path: entry.path,
    content: entry.content,
  }));
}

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
  timeoutMs?: number;
};

function normalizeHookEntry(
  entry: RawHookCommand,
  matcher: string,
  pluginRoot: string,
): HookEntry | null {
  const type = entry.type;
  if (isNonCommandHookType(type)) {
    return null;
  }

  let timeoutMs: number | undefined;
  if (typeof entry.timeoutMs === "number") {
    timeoutMs = entry.timeoutMs;
  } else if (typeof entry.timeout === "number") {
    timeoutMs = entry.timeout * 1000;
  }

  if (type === "prompt") {
    if (typeof entry.prompt !== "string") return null;
    return {
      type: "prompt",
      matcher,
      prompt: entry.prompt,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
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
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
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

function loadHooks(manifest: PluginManifest, hooksDir: string, root: string): HooksSettings | null {
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

export function loadPluginFromDirectory(
  pluginDir: string,
  source: string,
  options?: { requireManifest?: boolean },
): LoadedPlugin | null {
  const root = resolve(pluginDir);
  const manifestPath = resolveManifestPath(root);

  let manifest: PluginManifest;
  if (manifestPath === null) {
    if (options?.requireManifest) return null;
    const hasImplicitLayout = [
      "commands",
      "agents",
      "skills",
      "hooks",
      "workflows",
      ".mcp.json",
    ].some((entry) => existsAt(join(root, entry)));
    const fallbackName = basename(root);
    if (!hasImplicitLayout || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fallbackName)) return null;
    manifest = { name: fallbackName };
  } else {
    let raw: unknown;
    try {
      raw = readJsonFile(manifestPath);
    } catch {
      return null;
    }
    try {
      manifest = parseManifest(raw);
    } catch {
      return null;
    }
  }
  const commandsPath = join(root, "commands");
  const agentsPath = join(root, "agents");
  const skillsPath = join(root, "skills");
  const workflowsPath = join(root, "workflows");
  const hooksDir = join(root, "hooks");

  const installation = findPluginInstallationByPath(root);
  const plugin: LoadedPlugin = {
    name: manifest.name,
    path: root,
    source: installation?.marketplace ?? source,
    manifest,
  };

  if (isDirectory(commandsPath)) {
    plugin.commandsPath = commandsPath;
  }

  if (isDirectory(agentsPath)) {
    plugin.agentsPath = agentsPath;
  }

  if (isDirectory(skillsPath)) {
    plugin.skillsPath = skillsPath;
  }

  if (isDirectory(workflowsPath)) {
    plugin.workflowsPath = workflowsPath;
  }

  const hooksConfig = loadHooks(manifest, hooksDir, root);
  if (hooksConfig !== null) {
    plugin.hooksConfig = hooksConfig;
  }

  return plugin;
}

export function resolvePluginComponents(plugin: LoadedPlugin): ResolvedPlugin {
  const root = resolve(plugin.path);
  const commandSpec = plugin.manifest.commands;
  const commandEntries =
    typeof commandSpec === "string" || Array.isArray(commandSpec)
      ? (Array.isArray(commandSpec) ? commandSpec : [commandSpec]).flatMap((path) =>
          collectMdPath(path, root),
        )
      : plugin.commandsPath
        ? collectMdFiles(plugin.commandsPath, root)
        : [];
  const commands: ResolvedCommand[] = commandEntries.map((entry) => ({
    name: entry.name,
    path: entry.path,
    content: entry.content,
  }));
  if (commandSpec && typeof commandSpec === "object" && !Array.isArray(commandSpec)) {
    for (const [name, metadata] of Object.entries(commandSpec)) {
      const existing = commands.find((command) => command.name === name);
      if (metadata.content !== undefined) {
        const inline = { name, path: root, content: metadata.content, metadata };
        if (existing) Object.assign(existing, inline);
        else commands.push(inline);
        continue;
      }
      if (metadata.source !== undefined) {
        const sourced = collectMdPath(metadata.source, root)[0];
        if (!sourced) continue;
        const command = { name, path: sourced.path, content: sourced.content, metadata };
        if (existing) Object.assign(existing, command);
        else commands.push(command);
        continue;
      }
      if (existing) existing.metadata = metadata;
    }
  }

  const agentSpecs = plugin.manifest.agents;
  const agentEntries = agentSpecs
    ? (Array.isArray(agentSpecs) ? agentSpecs : [agentSpecs]).flatMap((path) =>
        collectMdPath(path, root),
      )
    : plugin.agentsPath
      ? collectMdFiles(plugin.agentsPath, root)
      : [];
  const agents: ResolvedAgent[] = agentEntries.map((entry) => ({
    id: entry.name,
    path: entry.path,
    content: entry.content,
  }));

  const skillSpecs = plugin.manifest.skills;
  const skills = skillSpecs
    ? (Array.isArray(skillSpecs) ? skillSpecs : [skillSpecs]).flatMap((path) =>
        collectSkillPath(path, root),
      )
    : plugin.skillsPath
      ? collectSkillEntries(plugin.skillsPath, root)
      : [];

  const hooks: HooksSettings | null = plugin.hooksConfig ?? null;

  return { plugin, commands, agents, skills, hooks };
}

export function loadPluginsFromDirectories(dirs: string[]): PluginLoadResult {
  const plugins: LoadedPlugin[] = [];
  const errors: PluginLoadError[] = [];

  for (const dir of dirs) {
    if (!isDirectory(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const pluginDir = join(dir, entry);
      if (!isDirectory(pluginDir)) continue;
      try {
        const loaded = loadPluginFromDirectory(pluginDir, dir);
        if (loaded !== null) {
          plugins.push(loaded);
        }
      } catch (e) {
        errors.push({
          path: pluginDir,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  const loadsManagedInstalls = dirs.some(
    (dir) => resolve(dir) === resolve(configRoot(), "plugins", "installed"),
  );
  if (loadsManagedInstalls) {
    const loadedPaths = new Set(plugins.map((plugin) => resolve(plugin.path)));
    for (const installation of listPluginInstallations()) {
      const installPath = resolve(installation.installPath);
      if (loadedPaths.has(installPath) || !isDirectory(installPath)) continue;
      try {
        const loaded = loadPluginFromDirectory(installPath, installation.marketplace, {
          requireManifest: true,
        });
        if (loaded) {
          plugins.push(loaded);
          loadedPaths.add(installPath);
        }
      } catch (error) {
        errors.push({
          path: installPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { plugins, errors };
}
