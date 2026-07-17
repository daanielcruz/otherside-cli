import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { SubagentDef } from "@/engine/agents/registry.ts";
import * as providers from "@/engine/providers/registry.ts";
import { announceDeferredTool, clearDeferredAnnouncements } from "@/engine/tools/deferred.ts";
import { getBashPrompt } from "@/engine/tools/dynamic/Bash.ts";
import { registerAllBuiltins } from "@/engine/tools/register-builtins.ts";
import {
  clearAssembledTurn,
  providerToolDeclarations,
  setAssembledTurn,
} from "@/engine/translator/index.ts";
import type { ComposedHarness } from "@/harness/composer/injections.ts";
import { DEFAULT_CONFIG, type WorkflowSizeGuideline } from "@/kernel/config/config.ts";
import type { OrchestrationMode } from "@/kernel/config/orchestration-mode.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { buildSubagentBaseDeclarations, withStructuredOutputDeclaration } from "../loop-runner.ts";
import { buildForkMessages } from "../messages.ts";
import { resolveAllowSetForFork, resolveWorkflowAgentProfile } from "../profile.ts";
import type { ForkSpec } from "../types.ts";

const ANTHROPIC_NAMED = [
  "Agent",
  "Bash",
  "Edit",
  "Read",
  "Skill",
  "ToolSearch",
  "DeferredToolPlaceholder",
  "Write",
];
const ANTHROPIC_FORK = [
  "Agent",
  "AskUserQuestion",
  "Bash",
  "Edit",
  "Read",
  "ReportFindings",
  "Skill",
  "ToolSearch",
  "Workflow",
  "DeferredToolPlaceholder",
  "Write",
];
const sessions = new Set<string>();

beforeAll(() => {
  registerAllBuiltins();
});

afterEach(() => {
  clearDeferredAnnouncements();
  for (const sessionId of sessions) clearAssembledTurn(sessionId);
  sessions.clear();
});

function context(
  provider: ProviderId,
  label: string,
  orchestrationMode: OrchestrationMode = "disabled",
): RequestContext {
  const sessionId = `subagent-declarations-${provider}-${label}`;
  sessions.add(sessionId);
  return {
    provider,
    model: provider === "anthropic" ? "claude-opus-4-8" : "gpt-5.4",
    effort: null,
    permissionMode: "default",
    orchestrationMode,
    sessionId,
    cwd: process.cwd(),
  };
}

function spec(ctx: RequestContext, inheritParentTurn = false): ForkSpec {
  return {
    ctx,
    name: inheritParentTurn ? "fork" : "named",
    body: "test agent",
    allowSet: null,
    prompt: "test declarations",
    allowNestedAgents: true,
    ...(inheritParentTurn ? { inheritParentTurn: true } : {}),
  };
}

function wildcardAgentDef(): SubagentDef {
  return {
    id: "wildcard-test",
    name: "Wildcard Test",
    description: "test",
    body: "test",
    tools: { kind: "wildcard" },
    disallowedTools: null,
    model: {},
    background: false,
    scope: "builtin",
  };
}

function seedParent(
  ctx: RequestContext,
  workflowSizeGuideline?: WorkflowSizeGuideline,
): ReturnType<typeof providerToolDeclarations> {
  const parentTools = providerToolDeclarations(
    providers.get(ctx.provider),
    workflowSizeGuideline === undefined ? undefined : { ...DEFAULT_CONFIG, workflowSizeGuideline },
    { model: ctx.model },
  );
  for (const name of ["TaskOutput", "TaskStop"]) {
    parentTools.push({
      name,
      description: `parent ${name}`,
      input_schema: { type: "object", properties: {} },
    });
  }
  setAssembledTurn(ctx.sessionId, {
    harness: {} as ComposedHarness,
    tools: parentTools,
  });
  return parentTools;
}

describe("subagent wire declarations", () => {
  test("wildcard async agents resolve to the async tool roster", () => {
    const ctx = context("anthropic", "wildcard-profile");
    const allowSet = resolveAllowSetForFork(wildcardAgentDef(), "subagent", ctx);

    expect(allowSet).toBeInstanceOf(Set);
    expect(allowSet.has("TaskStop")).toBe(true);
    expect(allowSet.has("TaskCreate")).toBe(false);
    expect(allowSet.has("TaskGet")).toBe(false);
    expect(allowSet.has("TaskList")).toBe(false);
    expect(allowSet.has("TaskUpdate")).toBe(false);
  });

  test("wildcard async requests omit planning tasks after deferred activation", () => {
    const ctx = context("anthropic", "wildcard-loaded-task");
    const asyncSpec = {
      ...spec(ctx),
      allowSet: resolveAllowSetForFork(wildcardAgentDef(), "subagent", ctx),
    };
    const planningTaskTools = ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"];
    for (const name of planningTaskTools) announceDeferredTool(name);

    const names = buildSubagentBaseDeclarations(asyncSpec, ctx).declarations.map(
      (declaration) => declaration.name,
    );
    for (const name of planningTaskTools) expect(names).not.toContain(name);
  });

  test("bare workflow workers receive the shared planning task roster", () => {
    const profile = resolveWorkflowAgentProfile(
      undefined,
      context("anthropic", "workflow-profile"),
    );
    if (!profile.ok) throw new Error(profile.error);

    expect(profile.allowSet).toBeInstanceOf(Set);
    expect(profile.allowSet?.has("TaskCreate")).toBe(true);
    expect(profile.allowSet?.has("TaskGet")).toBe(true);
    expect(profile.allowSet?.has("TaskList")).toBe(true);
    expect(profile.allowSet?.has("TaskStop")).toBe(true);
    expect(profile.allowSet?.has("TaskUpdate")).toBe(true);
    expect(profile.allowSet?.has("TaskOutput")).toBe(false);
  });

  test("named Anthropic subagents use the lean base pack with dynamic descriptions", () => {
    const ctx = context("anthropic", "named");
    const { declarations } = buildSubagentBaseDeclarations(spec(ctx), ctx);

    expect(declarations.map((declaration) => declaration.name)).toEqual(ANTHROPIC_NAMED);
    expect(declarations.some((declaration) => declaration.name.startsWith("Task"))).toBe(false);

    const bash = declarations.find((declaration) => declaration.name === "Bash");
    expect(bash?.description).toBe(getBashPrompt({ lean: true }));
    expect(bash?.description.length).toBeGreaterThan(0);

    const agent = declarations.find((declaration) => declaration.name === "Agent");
    expect(agent?.description).not.toContain("## When to fork");
    expect(agent?.description).not.toContain("Don't peek");
    expect(
      declarations.find((declaration) => declaration.name === "DeferredToolPlaceholder"),
    ).toEqual({
      name: "DeferredToolPlaceholder",
      description:
        "Reserved placeholder that keeps deferred tool loading active; never call this tool.",
      input_schema: { type: "object", properties: {} },
      defer_loading: true,
    });
  });

  test("named Agent declarations expose only the current orchestration mode fields", () => {
    const cases = [
      {
        mode: "disabled" as const,
        present: ["model"],
        absent: ["provider", "tier"],
      },
      {
        mode: "default" as const,
        present: ["provider", "model"],
        absent: ["tier"],
      },
      {
        mode: "feudalism" as const,
        present: ["tier"],
        absent: ["provider", "model"],
      },
    ];

    for (const { mode, present, absent } of cases) {
      const ctx = context("anthropic", `named-${mode}`, mode);
      const agent = buildSubagentBaseDeclarations(spec(ctx), ctx).declarations.find(
        (declaration) => declaration.name === "Agent",
      );
      expect(agent).toBeDefined();
      const properties = (agent?.input_schema.properties ?? {}) as Record<string, unknown>;
      for (const field of present) expect(properties).toHaveProperty(field);
      for (const field of absent) expect(properties).not.toHaveProperty(field);

      if (mode === "disabled") {
        const model = properties.model as { description?: string } | undefined;
        expect(model?.description).toContain("current provider");
        expect(model?.description).not.toContain("ANOTHER provider");
        expect(model?.description).not.toContain("provider together with model");
      }
    }
  });

  test("injects StructuredOutput only for a request with an output schema", () => {
    const ctx = context("anthropic", "named-structured-output");
    const base = buildSubagentBaseDeclarations(spec(ctx), ctx).declarations;
    expect(base.some((declaration) => declaration.name === "StructuredOutput")).toBe(false);

    const outputSchema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    };
    const injected = withStructuredOutputDeclaration(base, outputSchema);
    expect(injected.at(-1)).toEqual(
      expect.objectContaining({
        name: "StructuredOutput",
        input_schema: outputSchema,
      }),
    );
  });

  test("named subagent folds notes and environment without a deferred announcement", () => {
    const ctx = context("anthropic", "named-reminder");
    const namedSpec = spec(ctx);

    const messages = buildForkMessages(ctx, namedSpec.name, namedSpec.body, namedSpec.prompt);
    const blocks = messages[0]?.content.filter((block) => block.type === "text") ?? [];
    const folded = blocks.at(-1)?.text ?? "";

    expect(folded).toContain("Notes:");
    expect(folded).toContain("<env>");
    expect(folded).toContain("Working directory:");
    expect(folded).toContain("# Scratchpad Directory");
    expect(folded).not.toContain("The following deferred tools are now available via ToolSearch");
    expect(
      messages[0]?.content.map((b) => (b.type === "text" ? b.text : "")).join("\n"),
    ).not.toContain("<system-reminder>");
  });

  test("named subagents declare a deferred tool after ToolSearch announces it", () => {
    const ctx = context("anthropic", "named-loaded-deferred");
    const namedSpec = spec(ctx);

    expect(buildSubagentBaseDeclarations(namedSpec, ctx).declarations).not.toContainEqual(
      expect.objectContaining({ name: "SendMessage" }),
    );
    announceDeferredTool("SendMessage");
    expect(buildSubagentBaseDeclarations(namedSpec, ctx).declarations).toContainEqual(
      expect.objectContaining({ name: "SendMessage" }),
    );
  });

  test("named non-Anthropic subagents omit only the deferred placeholder", () => {
    const ctx = context("codex", "named");
    const { declarations } = buildSubagentBaseDeclarations(spec(ctx), ctx);

    expect(declarations.map((declaration) => declaration.name)).toEqual(
      ANTHROPIC_NAMED.filter((name) => name !== "DeferredToolPlaceholder"),
    );
  });

  test("inherited Anthropic forks retain the parent base pack and descriptions", () => {
    const ctx = context("anthropic", "fork");
    const parentAgent = seedParent(ctx).find((declaration) => declaration.name === "Agent");

    const { declarations } = buildSubagentBaseDeclarations(spec(ctx, true), ctx);

    expect(declarations.map((declaration) => declaration.name)).toEqual(ANTHROPIC_FORK);
    expect(declarations.some((declaration) => declaration.name.startsWith("Task"))).toBe(false);
    const forkAgent = declarations.find((declaration) => declaration.name === "Agent");
    expect(forkAgent).toBe(parentAgent);
    expect(forkAgent?.description).toContain("## When to fork");
    expect(forkAgent?.description).toContain("Don't peek");
  });

  test("inherited forks retain Workflow-only size guidance from the current parent turn", () => {
    const ctx = context("anthropic", "fork-workflow-size");
    const parentTools = seedParent(ctx, "small");
    const parentWorkflow = parentTools.find((declaration) => declaration.name === "Workflow");
    const parentAgent = parentTools.find((declaration) => declaration.name === "Agent");

    const { declarations } = buildSubagentBaseDeclarations(spec(ctx, true), ctx);
    const workflow = declarations.find((declaration) => declaration.name === "Workflow");
    const agent = declarations.find((declaration) => declaration.name === "Agent");

    expect(workflow).toBe(parentWorkflow);
    expect(workflow?.description).toContain("small workflow size guideline");
    expect(agent).toBe(parentAgent);
    expect(agent?.description).not.toContain("workflow size guideline");
  });

  test("inherited non-Anthropic forks omit only the deferred placeholder", () => {
    const ctx = context("codex", "fork");
    seedParent(ctx);
    const { declarations } = buildSubagentBaseDeclarations(spec(ctx, true), ctx);

    expect(declarations.map((declaration) => declaration.name)).toEqual(
      ANTHROPIC_FORK.filter((name) => name !== "DeferredToolPlaceholder"),
    );
    expect(declarations.some((declaration) => declaration.name.startsWith("Task"))).toBe(false);
  });
});
