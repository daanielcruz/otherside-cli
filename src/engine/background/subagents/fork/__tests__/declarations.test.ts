import { afterEach, beforeAll, describe, expect, test } from "bun:test";
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
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { buildSubagentBaseDeclarations, withStructuredOutputDeclaration } from "../loop-runner.ts";
import { buildForkMessages } from "../messages.ts";
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

function context(provider: ProviderId, label: string): RequestContext {
  const sessionId = `subagent-declarations-${provider}-${label}`;
  sessions.add(sessionId);
  return {
    provider,
    model: provider === "anthropic" ? "claude-opus-4-8" : "gpt-5.4",
    effort: null,
    permissionMode: "default",
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

function seedParent(ctx: RequestContext): ReturnType<typeof providerToolDeclarations> {
  const parentTools = providerToolDeclarations(providers.get(ctx.provider), undefined, {
    model: ctx.model,
  });
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
      expect.objectContaining({ name: "StructuredOutput", input_schema: outputSchema }),
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
