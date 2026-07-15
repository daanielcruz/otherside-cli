import { existsSync } from "node:fs";
import { CATALOG, type SlashCommand } from "@/commands/catalog.ts";
import { DEFAULT_BY_KIND, HANDLERS } from "@/commands/handlers.ts";
import { commandHint } from "@/commands/hints.ts";
import type { SlashContext, SlashResult } from "@/commands/types.ts";
import { resolvePluginComponents } from "@/engine/plugins/loader.ts";
import * as pluginsRegistry from "@/engine/plugins/registry.ts";
import * as skillsRegistry from "@/engine/skills/registry.ts";

export type { PendingChange, SlashContext, SlashResult } from "@/commands/types.ts";
export { isAbortMessage } from "@/commands/types.ts";

export function looksLikeCommand(token: string): boolean {
  if (token === "") return false;
  return !/[^a-zA-Z0-9:\-_]/.test(token);
}

function sortedCatalog(): readonly SlashCommand[] {
  return [...CATALOG].sort((a, b) => a.name.localeCompare(b.name));
}

function lookupByName(): ReadonlyMap<string, SlashCommand> {
  const map = new Map<string, SlashCommand>();
  for (const cmd of CATALOG) {
    map.set(cmd.name.toLowerCase(), cmd);
    if (cmd.aliases) {
      for (const alias of cmd.aliases) map.set(alias.toLowerCase(), cmd);
    }
  }
  return map;
}

export function lookup(name: string): SlashCommand | undefined {
  const builtin = lookupByName().get(name.toLowerCase());
  if (builtin) return builtin;

  const skill = skillsRegistry.get(name.toLowerCase());
  if (skill) {
    return {
      name: skill.name,
      kind: "skill",
      description: commandHint(skill.name, skill.description || "Dynamic skill"),
      ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
      aliases: skill.aliases,
    };
  }

  for (const plugin of pluginsRegistry.list()) {
    if (!pluginsRegistry.isRuntimeEnabled(plugin.name)) continue;
    const resolved = resolvePluginComponents(plugin);
    for (const cmd of resolved.commands) {
      const fullCmdName = `${plugin.name}:${cmd.name}`;
      if (fullCmdName.toLowerCase() === name.toLowerCase()) {
        return {
          name: fullCmdName,
          kind: "skill",
          description: commandHint(fullCmdName, cmd.metadata?.description || "Plugin command"),
          ...(cmd.metadata?.argumentHint ? { argumentHint: cmd.metadata.argumentHint } : {}),
        };
      }
    }
  }

  return undefined;
}

export function listCompletions(prefix: string): SlashCommand[] {
  if (/\s/.test(prefix)) return [];
  const p = prefix.toLowerCase();

  const all: SlashCommand[] = [...sortedCatalog()];
  for (const skill of skillsRegistry.list()) {
    if (!all.some((c) => c.name === skill.name)) {
      all.push({
        name: skill.name,
        kind: "skill",
        description: commandHint(skill.name, skill.description || "Dynamic skill"),
        ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
        aliases: skill.aliases,
      });
    }
  }
  for (const plugin of pluginsRegistry.list()) {
    if (!pluginsRegistry.isRuntimeEnabled(plugin.name)) continue;
    const resolved = resolvePluginComponents(plugin);
    for (const cmd of resolved.commands) {
      all.push({
        name: `${plugin.name}:${cmd.name}`,
        kind: "skill",
        description: commandHint(
          `${plugin.name}:${cmd.name}`,
          cmd.metadata?.description || "Plugin command",
        ),
        ...(cmd.metadata?.argumentHint ? { argumentHint: cmd.metadata.argumentHint } : {}),
      });
    }
  }

  if (p.length === 0) return all.sort((a, b) => a.name.localeCompare(b.name));
  return all
    .filter((c) => c.name.toLowerCase().startsWith(p))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = Array.from({ length: n + 1 }, () => 0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val1 = (curr[j - 1] ?? 0) + 1;
      const val2 = (prev[j] ?? 0) + 1;
      const val3 = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(val1, val2, val3);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? 0;
}

export function findClosestCommand(name: string): string | null {
  const target = name.toLowerCase();
  let bestCommand: string | null = null;
  let bestDistance = Infinity;

  const allNames = new Set<string>();
  for (const cmd of CATALOG) {
    allNames.add(cmd.name);
    for (const alias of cmd.aliases || []) allNames.add(alias);
  }
  for (const skill of skillsRegistry.list()) {
    allNames.add(skill.name);
    for (const alias of skill.aliases || []) allNames.add(alias);
  }
  for (const plugin of pluginsRegistry.list()) {
    if (!pluginsRegistry.isRuntimeEnabled(plugin.name)) continue;
    const resolved = resolvePluginComponents(plugin);
    for (const cmd of resolved.commands) {
      allNames.add(`${plugin.name}:${cmd.name}`);
    }
  }

  for (const checkName of allNames) {
    const dist = editDistance(checkName.toLowerCase(), target);
    if (dist <= 2 && dist < bestDistance) {
      bestDistance = dist;
      bestCommand = checkName;
    }
  }
  return bestCommand;
}

export async function dispatch(input: string, ctx: SlashContext): Promise<SlashResult> {
  if (!input.startsWith("/")) return { kind: "unknown", feedback: "not a slash command" };
  const tail = input.slice(1).trim();
  const [name] = tail.split(/\s+/);
  if (!name) return { kind: "unknown", feedback: "empty command" };
  const cmd = lookup(name);
  if (!cmd) {
    if (!looksLikeCommand(name) || existsSync("/" + name)) {
      return { kind: "unknown", shouldQuery: true };
    }
    let feedback = `Unknown command: /${name}`;
    const suggestion = findClosestCommand(name);
    if (suggestion) {
      feedback += `. Did you mean /${suggestion}?`;
    }
    const args = tail.slice(name.length).trim();
    if (args) {
      feedback += `\nArgs from unknown skill: ${args}`;
    }
    return { kind: "unknown", feedback };
  }
  const args = tail.slice(name.length).trim();
  const handler = HANDLERS[cmd.name] ?? DEFAULT_BY_KIND[cmd.kind];
  return handler(cmd, args, ctx);
}
