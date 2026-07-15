import type { SubagentDef } from "@/engine/agents/registry.ts";
import { publish } from "@/engine/background/tasks/bus.ts";
import { get as getSkill, list as listSkills, type Skill } from "@/engine/skills/registry.ts";
import { renderSkillBody } from "@/engine/tools/builtins/skill.ts";
import type { Message } from "@/kernel/std/types/message.ts";

const SKILL_INSTRUCTIONS_TAG = "skill-instructions";

export function skillMessagesForDef(def: SubagentDef): Message[] {
  const messages: Message[] = [];
  for (const name of def.skills ?? []) {
    const skill = resolveSkillByName(name);
    if (!skill) {
      publish("error", `Agent "${def.id}": skill "${name}" not found — skipped`);
      continue;
    }
    if (skill.context === "fork") {
      publish("error", `Agent "${def.id}": skill "${skill.name}" is fork-context — skipped`);
      continue;
    }
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `<${SKILL_INSTRUCTIONS_TAG} name="${skill.name}">\n${renderSkillBody(skill.body)}\n</${SKILL_INSTRUCTIONS_TAG}>`,
        },
      ],
    });
  }
  return messages;
}

function resolveSkillByName(name: string): Skill | undefined {
  const direct = getSkill(name);
  if (direct) return direct;
  const suffix = `:${name}`;
  return listSkills().find((s) => s.name.endsWith(suffix));
}
