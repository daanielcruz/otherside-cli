import { get as getSkill } from "@/engine/skills/registry.ts";
import { commandHint } from "./hints.ts";

export type SlashKind =
  | "instant"
  | "toggle"
  | "skill"
  | "workflow"
  | "anchor"
  | "panel"
  | "auth"
  | "external";

export interface SlashCommand {
  name: string;
  kind: SlashKind;
  description: string;
  argumentHint?: string;
  aliases?: readonly string[];
}

const EARLY_SKILL_ORDER = ["dream", "pr-review", "init", "loop"] as const;
const LATE_SKILL_ORDER = ["pr-security-review", "deep-security-review", "grill-me"] as const;

function skillCommand(name: string): SlashCommand | null {
  const skill = getSkill(name);
  if (!skill?.userInvocable) return null;
  return {
    name: skill.name,
    kind: "skill",
    description: commandHint(skill.name, skill.description || "Dynamic skill"),
    ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
    ...(skill.aliases.length > 0 ? { aliases: skill.aliases } : {}),
  };
}

function skillCommands(names: readonly string[]): SlashCommand[] {
  return names.flatMap((name) => {
    const command = skillCommand(name);
    return command ? [command] : [];
  });
}

export function buildCatalog(): SlashCommand[] {
  const commands: SlashCommand[] = [
    { name: "exit", kind: "instant", description: "exit the TUI", aliases: ["quit"] },
    {
      name: "clear",
      kind: "instant",
      description: "wipe history, re-splash mascot",
    },
    {
      name: "cd",
      kind: "instant",
      description: "Change the current working directory",
      argumentHint: "<path>",
    },
    {
      name: "plan",
      kind: "toggle",
      description: "enable plan mode",
      argumentHint: "[<description>]",
    },
    {
      name: "fast",
      kind: "toggle",
      description: "toggle fast mode - codex only",
      argumentHint: "[on|off]",
    },
    {
      name: "parallel",
      kind: "toggle",
      description: "toggle parallel agent tasks",
      argumentHint: "[on|off]",
    },
    {
      name: "multiprovider",
      kind: "toggle",
      description: "toggle multi-provider routing",
      argumentHint: "[on|off]",
    },
    {
      name: "copy",
      kind: "toggle",
      description: "copy the last assistant response (/copy N for older)",
      argumentHint: "[N]",
    },
    {
      name: "export",
      kind: "toggle",
      description: "export the current conversation to a file or clipboard",
      argumentHint: "[file|clipboard]",
    },
    {
      name: "toggle-memory",
      kind: "toggle",
      description: "toggle auto memory for this session",
    },
    ...skillCommands(EARLY_SKILL_ORDER),
    {
      name: "btw",
      kind: "instant",
      description: "answer a side question without disturbing the main thread",
      argumentHint: "<question>",
      aliases: ["sidequest"],
    },
    ...skillCommands(LATE_SKILL_ORDER),
    {
      name: "ultraplan",
      kind: "workflow",
      description: "deep multi-agent implementation plan — explore, design, critique, synthesize",
      argumentHint: "<what to plan>",
    },
    {
      name: "goal",
      kind: "anchor",
      description: "Set a goal — keep working until the condition is met",
      argumentHint: "[<condition> | clear]",
    },
    {
      name: "branch",
      kind: "anchor",
      description: "fork the conversation from here",
      argumentHint: "[name]",
    },
    {
      name: "fork",
      kind: "instant",
      description: "Spawn a background agent that inherits the full conversation",
      argumentHint: "<directive>",
    },
    {
      name: "compact",
      kind: "anchor",
      description: "summarize history, trim tokens",
      argumentHint: "[custom summarization instructions]",
    },
    {
      name: "context",
      kind: "anchor",
      description: "visualize current context usage",
    },
    { name: "help", kind: "panel", description: "show slash command catalog" },
    {
      name: "resume",
      kind: "panel",
      description: "pick a past session to continue",
      argumentHint: "[session id or search]",
    },
    {
      name: "rewind",
      kind: "panel",
      description: "restore the code and/or conversation to a previous point",
      aliases: ["checkpoint"],
    },
    {
      name: "config",
      kind: "panel",
      description: "show the config file path",
      argumentHint: "[details]",
    },
    {
      name: "model",
      kind: "panel",
      description: "show or switch the active model",
      argumentHint: "[model]",
    },
    {
      name: "theme",
      kind: "panel",
      description: "show or switch the active theme",
    },
    {
      name: "effort",
      kind: "panel",
      description: "tune reasoning effort (low/med/high/xhigh/max/auto)",
      argumentHint: "[low|medium|high|xhigh|max|auto]",
    },
    {
      name: "permissions",
      kind: "panel",
      description: "manage tool permission rules",
    },
    {
      name: "hooks",
      kind: "panel",
      description: "view or edit hooks for tool events",
    },
    {
      name: "diff",
      kind: "panel",
      description: "view uncommitted or per-turn diffs",
    },
    { name: "skills", kind: "panel", description: "list available skills" },
    { name: "agents", kind: "panel", description: "manage agent configurations" },
    { name: "status", kind: "panel", description: "show session status" },
    { name: "usage", kind: "panel", description: "show provider usage" },
    { name: "stats", kind: "panel", description: "show provider stats" },
    {
      name: "mcp",
      kind: "panel",
      description: "manage MCP servers",
      argumentHint: "[enable|disable [server-name]]",
    },
    {
      name: "plugins",
      kind: "panel",
      aliases: ["plugin"],
      description: "manage plugins and marketplaces",
      argumentHint: "[install|update|uninstall|enable|disable <plugin@marketplace>|list]",
    },
    {
      name: "marketplace",
      kind: "instant",
      description: "manage plugin marketplaces",
      argumentHint: "[add <source>|remove <name>|update [name]|list]",
    },
    {
      name: "reload",
      kind: "instant",
      aliases: ["reload-plugins"],
      description: "reload skills, agents, and MCP servers without restarting",
    },
    {
      name: "tasks",
      kind: "panel",
      description: "list and manage background tasks",
    },
    {
      name: "bashes",
      kind: "panel",
      description: "list and manage background shells",
    },
    {
      name: "workflows",
      kind: "panel",
      description: "list and manage background workflows",
    },
    {
      name: "remote",
      kind: "panel",
      description: "link a phone and manage remote sessions",
    },
    {
      name: "login",
      kind: "auth",
      description: "sign in to a provider",
      argumentHint: "[provider]",
    },
    {
      name: "logout",
      kind: "auth",
      description: "sign out from a provider",
      argumentHint: "[provider]",
    },
    {
      name: "design",
      kind: "panel",
      description: "manage Otherside Design sessions",
      argumentHint: "[prompt]",
    },
  ];
  return commands.map((command) => ({
    ...command,
    description: commandHint(command.name, command.description),
  }));
}

export const CATALOG: SlashCommand[] = new Proxy([] as SlashCommand[], {
  get(_target, property) {
    const catalog = buildCatalog();
    const value = Reflect.get(catalog, property, catalog);
    return typeof value === "function" ? value.bind(catalog) : value;
  },
});
