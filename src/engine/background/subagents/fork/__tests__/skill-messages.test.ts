import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithPermissionResolver } from "@/engine/agents/agent-context.ts";
import type { SubagentDef } from "@/engine/agents/registry.ts";
import { clearForkLifecyclesForTests } from "@/engine/background/subagents/lifecycle.ts";
import { clear as clearBackgroundTasks } from "@/engine/background/tasks/background.ts";
import type { Provider } from "@/engine/contract/types.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import * as providers from "@/engine/providers/registry.ts";
import { clear as clearSkills, register as registerSkill } from "@/engine/skills/registry.ts";
import * as skillUsage from "@/engine/skills/usage.ts";
import { registerAllBuiltins } from "@/engine/tools/register-builtins.ts";
import type { ForkEvent, ProviderEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

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

describe("loaded skill fork messages", () => {
  test.each([
    "slash",
    "tool",
  ] as const)("marks the %s invocation in the request sent to the provider", async (source) => {
    registerAllProviders();
    const root = mkdtempSync(join(tmpdir(), "loaded-skill-"));
    const priorConfig = process.env.OTHERSIDE_CONFIG_DIR;
    const priorSessions = process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = join(root, "config");
    process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = join(root, "sessions");
    const captures: Message[][] = [];
    const events: ForkEvent[] = [];
    const lookup = providers.get;
    const output =
      "The loaded fixture completed directly with enough detail to finish without another expansion request.";
    const stub: Provider = {
      ...lookup("codex"),
      translateRequest: (_ctx, messages) => {
        captures.push(structuredClone(messages));
        return {};
      },
      startStreamAttempt: () => ({
        events: (async function* (): AsyncIterable<ProviderEvent> {
          yield { kind: "text_delta", text: output };
          yield { kind: "message_stop", stop_reason: "stop" };
        })(),
        abort: () => {},
      }),
    };
    const providerLookup = spyOn(providers, "get").mockImplementation((id) =>
      id === "codex" ? stub : lookup(id),
    );
    const usage = spyOn(skillUsage, "recordSkillUse").mockImplementation(() => {});
    const body = "Perform this loaded fixture directly. Do not invoke another skill.";
    const prompt = "Keep the requested fixture arguments intact.";
    const definition = { ...skill("loaded-fixture", "fork"), body };
    registerSkill(definition);
    const ctx: RequestContext = {
      provider: "codex",
      model: "gpt-6-astra",
      effort: "high",
      permissionMode: "default",
      sessionId: "loaded-fixture-session",
      cwd: root,
      eventSink: (event) => events.push(event),
    };
    const permissionResolver = async (): Promise<"deny"> => "deny";
    try {
      const { dispatchSkillFork } = await import("../spawn.ts");
      const { Skill } = await import("@/engine/tools/builtins/skill.ts");
      if (source === "slash") {
        const result = await dispatchSkillFork({
          ctx,
          name: definition.name,
          body,
          prompt,
          permissionResolver,
        });
        expect(result.isError).toBe(false);
      } else {
        const result = await runWithPermissionResolver(permissionResolver, () =>
          Skill.run(
            {
              id: "loaded-skill-call",
              name: "Skill",
              input: { skill: definition.name, args: prompt },
            },
            ctx,
          ),
        );
        expect(result.is_error).not.toBe(true);
      }
      expect(captures).toHaveLength(1);
      expect(events.filter((event) => event.kind === "fork_start")).toHaveLength(1);
      const messages = captures[0] ?? [];
      const sent = JSON.stringify(messages);
      const marker = "<command-name>loaded-fixture</command-name>";
      expect(sent.split(marker)).toHaveLength(2);
      expect(sent.split(body)).toHaveLength(2);
      expect(messages.filter((message) => message.role === "user").at(-1)?.content).toContainEqual({
        type: "text",
        text: `${marker}\n${prompt}`,
      });
      expect(events.filter((event) => event.kind === "fork_tool_dispatch_start")).toHaveLength(0);
    } finally {
      providerLookup.mockRestore();
      usage.mockRestore();
      clearForkLifecyclesForTests();
      clearBackgroundTasks();
      if (priorConfig === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
      else process.env.OTHERSIDE_CONFIG_DIR = priorConfig;
      if (priorSessions === undefined) delete process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
      else process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = priorSessions;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
