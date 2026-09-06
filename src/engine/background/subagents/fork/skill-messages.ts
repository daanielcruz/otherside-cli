import type { SubagentDef } from "@/engine/agents/registry.ts";
import { get as getSkill, list as listSkills, type Skill } from "@/engine/skills/registry.ts";
import { renderSkillBody } from "@/engine/tools/builtins/skill.ts";
import type { Message } from "@/kernel/std/types/message.ts";

const SKILL_INSTRUCTIONS_TAG = "skill-instructions";

export interface SkillMessagesForDef {
  messages: Message[];
  warnings: string[];
}

export function skillMessagesForDef(def: SubagentDef): SkillMessagesForDef {
  const messages: Message[] = [];
  const warnings: string[] = [];
  for (const name of def.skills ?? []) {
    const skill = resolveSkillByName(name);
    if (!skill) {
      warnings.push(`agent "${def.id}" declares skill "${name}", which is not loaded — skipped`);
      continue;
    }
    if (skill.context === "fork") {
      warnings.push(
        `agent "${def.id}" declares skill "${skill.name}", which only runs as a fork — skipped`,
      );
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
  return { messages, warnings };
}

function resolveSkillByName(name: string): Skill | undefined {
  const direct = getSkill(name);
  if (direct) return direct;
  const suffix = `:${name}`;
  return listSkills().find((s) => s.name.endsWith(suffix));
}
