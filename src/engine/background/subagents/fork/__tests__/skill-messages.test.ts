import { afterEach, describe, expect, test } from "bun:test";
import type { SubagentDef } from "@/engine/agents/registry.ts";
import { clear as clearSkills, register as registerSkill } from "@/engine/skills/registry.ts";
import { registerAllBuiltins } from "@/engine/tools/register-builtins.ts";

// The tool registry has to settle before the fork module pulls the skill
// renderer out of it.
registerAllBuiltins();
const { skillMessagesForDef } = await import(
  "@/engine/background/subagents/fork/skill-messages.ts"
);

function skill(name: string, context: "inline" | "fork") {
  return {
    name,
    aliases: [],
    description: `${name} description`,
    whenToUse: "",
    argumentHint: null,
    userInvocable: true,
    modelInvocable: true,
    context,
    body: `${name} body`,
    builtin: false,
    source: "user" as const,
    authorModelLock: false,
  };
}

function def(skills: string[]): SubagentDef {
  return {
    id: "auditor",
    name: "Auditor",
    description: "audits",
    body: "",
    tools: null,
    disallowedTools: null,
    model: {},
    background: false,
    scope: "user",
    mcpServers: null,
    skills,
    hooks: null,
  } as unknown as SubagentDef;
}

afterEach(() => {
  clearSkills();
});

describe("skillMessagesForDef", () => {
  test("injects a message per resolved skill and reports no warnings", () => {
    registerSkill(skill("review", "inline"));

    const { messages, warnings } = skillMessagesForDef(def(["review"]));

    expect(warnings).toEqual([]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content[0]).toMatchObject({ type: "text" });
    const [block] = messages[0]?.content ?? [];
    expect(block?.type === "text" && block.text).toContain('<skill-instructions name="review">');
  });

  test("reports a skill the registry does not hold instead of dropping it silently", () => {
    const { messages, warnings } = skillMessagesForDef(def(["ghost"]));

    expect(messages).toEqual([]);
    expect(warnings).toEqual([
      'agent "auditor" declares skill "ghost", which is not loaded — skipped',
    ]);
  });

  test("reports a fork-context skill that cannot be inlined", () => {
    registerSkill(skill("ultraplan", "fork"));

    const { messages, warnings } = skillMessagesForDef(def(["ultraplan"]));

    expect(messages).toEqual([]);
    expect(warnings).toEqual([
      'agent "auditor" declares skill "ultraplan", which only runs as a fork — skipped',
    ]);
  });
});
