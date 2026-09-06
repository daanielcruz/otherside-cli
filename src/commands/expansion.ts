import { parseFrontmatter } from "@/engine/agents/frontmatter.ts";
import { resolvePluginComponents } from "@/engine/plugins/loader.ts";
import * as pluginsRegistry from "@/engine/plugins/registry.ts";
import * as skillsRegistry from "@/engine/skills/registry.ts";

/** Where a command's words came from, for the hook that watches expansions. */
export type ExpansionSource = "user" | "project" | "builtin" | "plugin";

export interface CommandExpansion {
  /** The command's words with the arguments already in place. */
  readonly prompt: string;
  readonly source: ExpansionSource;
}

const ARGUMENT_PLACEHOLDER = "$ARGUMENTS";

function pluginCommandBody(name: string): string | null {
  for (const { pluginId, plugin } of pluginsRegistry.list()) {
    if (!pluginsRegistry.isRuntimeEnabled(pluginId)) continue;
    for (const command of resolvePluginComponents(plugin).commands) {
      if (`${pluginId}:${command.name}`.toLowerCase() !== name.toLowerCase()) continue;
      // A command file carries the same frontmatter a skill does; the reader's
      // turn is the prose under it, never the metadata block.
      try {
        return parseFrontmatter(command.content).body;
      } catch {
        return command.content;
      }
    }
  }
  return null;
}

/**
 * The words a command sends as the turn, or null when nothing answers to the
 * name. A skill and a plugin command are both prompt expansions, so they
 * resolve here together rather than each growing its own path.
 */
export function expandCommand(name: string, args: string): CommandExpansion | null {
  const skill = skillsRegistry.get(name);
  if (skill) {
    return { prompt: skill.body.replaceAll(ARGUMENT_PLACEHOLDER, args), source: skill.source };
  }
  const body = pluginCommandBody(name);
  if (body === null) return null;
  return { prompt: body.replaceAll(ARGUMENT_PLACEHOLDER, args), source: "plugin" };
}
