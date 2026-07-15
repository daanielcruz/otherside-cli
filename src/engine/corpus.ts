import { delimiter, join } from "node:path";
import {
  loadAndRegister as loadAgent,
  loadFromDirectory,
  publishLoadFailures,
} from "@/engine/agents/loader.ts";
import { loadPluginsFromDirectories, resolvePluginComponents } from "@/engine/plugins/loader.ts";
import { gatherPluginMcpServers } from "@/engine/plugins/mcp.ts";
import {
  applyPersistedEnabledState,
  isRuntimeEnabled as isPluginRuntimeEnabled,
  register as registerPlugin,
} from "@/engine/plugins/registry.ts";
import {
  loadProjectCommandsFromDirectory,
  loadAndRegister as loadSkill,
  loadSkillsFromDirectory,
} from "@/engine/skills/loader.ts";
import explore from "@/harness/agents/fast-explorer/AGENT.md" with { type: "text" };
import generalPurpose from "@/harness/agents/generalist/AGENT.md" with { type: "text" };
import planAgent from "@/harness/agents/planner/AGENT.md" with { type: "text" };
import verifier from "@/harness/agents/verifier/AGENT.md" with { type: "text" };
import codeReviewSkill from "@/harness/skills/code-review/SKILL.md" with { type: "text" };
import deepSecurityReview from "@/harness/skills/deep-security-review/SKILL.md" with {
  type: "text",
};
import dreamSkill from "@/harness/skills/dream/SKILL.md" with { type: "text" };
import grillMeSkill from "@/harness/skills/grill-me/SKILL.md" with { type: "text" };
import initSkill from "@/harness/skills/init/SKILL.md" with { type: "text" };
import loopSkill from "@/harness/skills/loop/SKILL.md" with { type: "text" };
import prReviewSkill from "@/harness/skills/pr-review/SKILL.md" with { type: "text" };
import prSecurityReviewSkill from "@/harness/skills/pr-security-review/SKILL.md" with {
  type: "text",
};
import ultraplanSkill from "@/harness/skills/ultraplan/SKILL.md" with { type: "text" };
import { loadConfigSync } from "@/kernel/config/config.ts";
import { setPluginMcpServersProvider } from "@/kernel/mcp/config.ts";
import { configRoot } from "@/kernel/std/fs/paths.ts";

const AGENT_CORPUS: { id: string; src: string }[] = [
  { id: "explore", src: explore },
  { id: "general-purpose", src: generalPurpose },
  { id: "plan", src: planAgent },
  { id: "verifier", src: verifier },
];

const SKILL_CORPUS: { name: string; src: string }[] = [
  { name: "init", src: initSkill },
  { name: "dream", src: dreamSkill },
  { name: "grill-me", src: grillMeSkill },
  { name: "loop", src: loopSkill },
  { name: "pr-review", src: prReviewSkill },
  { name: "pr-security-review", src: prSecurityReviewSkill },
  { name: "deep-security-review", src: deepSecurityReview },
  { name: "code-review", src: codeReviewSkill },
  { name: "ultraplan", src: ultraplanSkill },
];

// Session-only plugin dirs from `--plugin-dir` (set by modes/args.ts).
function cliPluginDirs(): string[] {
  const raw = process.env.OTHERSIDE_FLAG_PLUGIN_DIRS;
  if (!raw) return [];
  return raw.split(delimiter).filter((d) => d.length > 0);
}

export function loadCorpus(): { agents: number; skills: number; plugins: number } {
  let agents = 0;
  for (const { id, src } of AGENT_CORPUS) {
    try {
      loadAgent(id, src, "builtin");
      agents += 1;
    } catch {}
  }
  const userAgents = loadFromDirectory(join(configRoot(), "agents"), "user");
  const projectAgents = loadFromDirectory(join(process.cwd(), ".otherside", "agents"), "project");
  agents += userAgents.defs.length + projectAgents.defs.length;
  publishLoadFailures([...userAgents.failures, ...projectAgents.failures]);
  let skills = 0;
  for (const { name, src } of SKILL_CORPUS) {
    try {
      loadSkill(name, src, true);
      skills += 1;
    } catch {}
  }
  skills += loadSkillsFromDirectory(join(configRoot(), "skills"));
  skills += loadSkillsFromDirectory(join(process.cwd(), ".otherside", "skills"));
  skills += loadProjectCommandsFromDirectory(join(process.cwd(), ".otherside", "commands"));

  const pluginDirs = [join(configRoot(), "plugins", "installed"), ...cliPluginDirs()];
  const pluginResult = loadPluginsFromDirectories(pluginDirs);
  for (const plugin of pluginResult.plugins) registerPlugin(plugin);
  applyPersistedEnabledState(loadConfigSync().enabledPlugins);

  let plugins = 0;
  for (const plugin of pluginResult.plugins) {
    if (!isPluginRuntimeEnabled(plugin.name)) {
      plugins += 1;
      continue;
    }
    const resolved = resolvePluginComponents(plugin);
    for (const agent of resolved.agents) {
      try {
        loadAgent(`${plugin.name}:${agent.id}`, agent.content, "user", agent.path);
        agents += 1;
      } catch {}
    }
    for (const skill of resolved.skills) {
      try {
        loadSkill(`${plugin.name}:${skill.name}`, skill.content, false);
        skills += 1;
      } catch {}
    }
    for (const cmd of resolved.commands) {
      try {
        let content = cmd.content;
        if (!content.startsWith("---")) {
          const desc = cmd.metadata?.description ?? "Plugin command";
          content = `---\ndescription: ${desc}\n---\n${content}`;
        }
        loadSkill(`${plugin.name}:${cmd.name}`, content, false);
        skills += 1;
      } catch {}
    }
    plugins += 1;
  }

  setPluginMcpServersProvider(gatherPluginMcpServers);

  return { agents, skills, plugins };
}
