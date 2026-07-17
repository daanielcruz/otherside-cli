import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveImageGeneratorProvider } from "@/engine/providers/image-generation.ts";
import * as providers from "@/engine/providers/registry.ts";
import {
  activeDeferredToolNames,
  announceDeferredTool,
  clearDeferredAnnouncements,
  forceAnnounceDeferredTool,
  pruneAnnouncedMcpTools,
} from "@/engine/tools/deferred.ts";
import { registerAllBuiltins } from "@/engine/tools/register-builtins.ts";
import * as toolRegistry from "@/engine/tools/registry.ts";
import { assembleProviderTurn } from "@/engine/translator/assemble.ts";
import { providerToolDeclarations } from "@/engine/translator/tools.ts";
import { makeQueue } from "@/harness/composer/queue.ts";
import { DEFAULT_CONFIG, type UserConfig } from "@/kernel/config/config.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { hasCredentialSync } from "@/kernel/storage/credentials.ts";

beforeAll(() => {
  registerAllBuiltins();
});

function withFakeCredentials<T>(credentials: Record<string, unknown>, fn: () => T): T {
  const previousConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  const configDir = mkdtempSync(join(tmpdir(), "otherside-tools-roster-"));
  writeFileSync(join(configDir, "credentials.json"), JSON.stringify(credentials));
  process.env.OTHERSIDE_CONFIG_DIR = configDir;
  try {
    return fn();
  } finally {
    if (previousConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = previousConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  }
}

function assembledAgentDescription(
  ctxOverrides: Partial<RequestContext>,
  config: UserConfig = DEFAULT_CONFIG,
): string {
  const ctx: RequestContext = {
    provider: "anthropic",
    model: "claude-opus-4-8",
    effort: null,
    permissionMode: "default",
    sessionId: "tool-description-fixture",
    cwd: process.cwd(),
    agentic: true,
    ...ctxOverrides,
  };
  const turn = assembleProviderTurn({
    ctx,
    provider: providers.get("anthropic"),
    messages: [],
    injections: makeQueue(),
    config,
    currentDate: "2026-07-12",
    gitStatus: "On branch main",
  });
  const agentTool = turn.tools.find((tool) => tool.name === "Agent");
  expect(agentTool).toBeDefined();
  return agentTool!.description;
}

describe("provider tool declarations", () => {
  it("declares GenerateImage for authenticated selected generators", () => {
    const config = { ...DEFAULT_CONFIG, imageGenProvider: "codex" as const };

    withFakeCredentials(
      {
        xai: {
          accessToken: "fake-xai-access",
          refreshToken: "fake-xai-refresh",
          expiresAt: 1_800_000_000_000,
        },
        codex: {
          accessToken: "fake-codex-access",
          refreshToken: "fake-codex-refresh",
          expiresAt: 1_800_000_000_000,
        },
        antigravity: {
          accessToken: "fake-antigravity-access",
          refreshToken: "fake-antigravity-refresh",
          expiresAt: 1_800_000_000_000,
        },
      },
      () => {
        expect(hasCredentialSync("xai")).toBe(true);
        for (const providerId of ["xai", "codex", "antigravity"] as const) {
          const tools = providerToolDeclarations(providers.get(providerId), config);
          expect(tools.map((tool) => tool.name)).toContain("GenerateImage");
          expect(resolveImageGeneratorProvider(config.imageGenProvider, providerId)).toBe("codex");
        }
        expect(
          providerToolDeclarations(providers.get("anthropic"), config).map((tool) => tool.name),
        ).toContain("GenerateImage");
      },
    );

    withFakeCredentials({}, () => {
      expect(hasCredentialSync("xai")).toBe(false);
      const tools = providerToolDeclarations(providers.get("xai"), config);
      expect(tools.map((tool) => tool.name)).not.toContain("GenerateImage");
    });
  });

  it("routes an explicit generator across native turns", () => {
    expect(resolveImageGeneratorProvider("xai", "codex")).toBe("xai");
    expect(resolveImageGeneratorProvider("codex", "antigravity")).toBe("codex");
  });

  it("adds the Anthropic deferred-tool placeholder in reference order", () => {
    const tools = providerToolDeclarations(providers.get("anthropic"));

    expect(tools.map((tool) => tool.name)).toEqual([
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
    ]);
    expect(tools.find((tool) => tool.name === "DeferredToolPlaceholder")).toEqual({
      name: "DeferredToolPlaceholder",
      description:
        "Reserved placeholder that keeps deferred tool loading active; never call this tool.",
      input_schema: { type: "object", properties: {} },
      defer_loading: true,
    });
    const agent = tools.find((tool) => tool.name === "Agent");
    expect(agent?.input_schema.properties).not.toHaveProperty("mode");
    const disabledProperties = agent?.input_schema.properties as
      | Record<string, unknown>
      | undefined;
    const disabledModel = disabledProperties?.model as { description?: string } | undefined;
    expect(disabledModel?.description).toContain("current provider");
    expect(disabledModel?.description).toContain("Takes precedence");
    expect(disabledModel?.description).toContain("fork");
    expect(disabledModel?.description).not.toContain("ANOTHER provider");
    expect(disabledModel?.description).not.toContain("provider together with model");

    const defaultTools = providerToolDeclarations(providers.get("anthropic"), {
      ...DEFAULT_CONFIG,
      orchestrationMode: "default",
    });
    const defaultProperties = defaultTools.find((tool) => tool.name === "Agent")?.input_schema
      .properties as Record<string, unknown> | undefined;
    const defaultModel = defaultProperties?.model as { description?: string } | undefined;
    expect(defaultModel?.description).toContain("ANOTHER provider");
  });

  it("adds workflow-size guidance only to Workflow declarations", () => {
    const unrestricted = providerToolDeclarations(providers.get("anthropic"), {
      ...DEFAULT_CONFIG,
      workflowSizeGuideline: "unrestricted",
    });
    const small = providerToolDeclarations(providers.get("anthropic"), {
      ...DEFAULT_CONFIG,
      workflowSizeGuideline: "small",
    });
    const description = (tools: typeof small, name: string) =>
      tools.find((tool) => tool.name === name)?.description;

    expect(description(small, "Workflow")).toContain("small workflow size guideline");
    expect(description(small, "Workflow")).toContain("warn the user before launching");
    expect(description(unrestricted, "Workflow")).not.toContain("workflow size guideline");
    expect(description(small, "Agent")).toBe(description(unrestricted, "Agent"));
    expect(description(small, "Agent")).not.toContain("workflow size guideline");
  });

  it("marks ToolSearch-loaded worktree schemas as deferred on the Anthropic wire", () => {
    clearDeferredAnnouncements();
    try {
      announceDeferredTool("EnterWorktree");
      announceDeferredTool("ExitWorktree");
      const tools = providerToolDeclarations(providers.get("anthropic"));
      const enter = tools.find((tool) => tool.name === "EnterWorktree");
      const exit = tools.find((tool) => tool.name === "ExitWorktree");
      expect(enter?.defer_loading).toBe(true);
      expect(exit?.defer_loading).toBe(true);
      expect(enter?.input_schema).toHaveProperty("properties.name");
      expect(exit?.input_schema).toHaveProperty("required", ["action"]);
    } finally {
      clearDeferredAnnouncements();
    }
  });

  it("eagerly declares only EnterWorktree in a background session", () => {
    const previous = process.env.CLAUDE_CODE_SESSION_KIND;
    clearDeferredAnnouncements();
    try {
      process.env.CLAUDE_CODE_SESSION_KIND = "bg";
      const tools = providerToolDeclarations(providers.get("anthropic"));
      expect(tools.find((tool) => tool.name === "EnterWorktree")?.defer_loading).toBeUndefined();
      expect(tools.map((tool) => tool.name)).not.toContain("ExitWorktree");
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_KIND;
      else process.env.CLAUDE_CODE_SESSION_KIND = previous;
      clearDeferredAnnouncements();
    }
  });

  it("keeps the same roster without the placeholder for non-Anthropic declarations", () => {
    const tools = providerToolDeclarations(providers.get("codex"));

    expect(tools.map((tool) => tool.name)).toEqual([
      "Agent",
      "AskUserQuestion",
      "Bash",
      "Edit",
      "Read",
      "ReportFindings",
      "Skill",
      "ToolSearch",
      "Workflow",
      "Write",
    ]);
  });

  it("exposes remote isolation only to Anthropic", () => {
    const anthropic = providerToolDeclarations(providers.get("anthropic"));
    const anthropicAgent = anthropic.find((tool) => tool.name === "Agent");
    const anthropicProperties = anthropicAgent?.input_schema.properties as
      | Record<string, unknown>
      | undefined;
    const anthropicIsolation = anthropicProperties?.isolation as {
      description?: string;
      type?: string;
      enum?: string[];
    };
    expect(anthropicIsolation).toEqual({
      description:
        'Isolation mode. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo. "remote" launches the agent in a remote cloud environment (always runs in background; availability is gated).',
      type: "string",
      enum: ["worktree", "remote"],
    });

    const codex = providerToolDeclarations(providers.get("codex"));
    const codexAgent = codex.find((tool) => tool.name === "Agent");
    const codexProperties = codexAgent?.input_schema.properties as
      | Record<string, unknown>
      | undefined;
    const codexIsolation = codexProperties?.isolation as {
      description?: string;
      enum?: string[];
    };
    expect(codexIsolation.enum).toEqual(["worktree"]);
    expect(codexIsolation.description).not.toContain("remote");
  });

  it("builds the Agent background field from the current env on every request", () => {
    const key = "OTHERSIDE_DISABLE_AGENT_AUTO_BACKGROUND";
    const original = process.env[key];
    try {
      delete process.env[key];
      const enabled = providerToolDeclarations(providers.get("anthropic"));
      const enabledAgent = enabled.find((tool) => tool.name === "Agent");
      expect(enabledAgent?.input_schema.properties).not.toHaveProperty("run_in_background");

      process.env[key] = "1";
      const disabled = providerToolDeclarations(providers.get("anthropic"));
      const disabledAgent = disabled.find((tool) => tool.name === "Agent");
      expect(disabledAgent?.input_schema.properties).toHaveProperty("run_in_background");
    } finally {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it("keeps fork guidance by default for the main agent", () => {
    const tools = providerToolDeclarations(providers.get("anthropic"));
    const description = tools.find((tool) => tool.name === "Agent")?.description;

    expect(description).toContain("## When to fork");
    expect(description).toContain("Don't peek");
  });

  it("strips only fork guidance for a subagent", () => {
    const tools = providerToolDeclarations(providers.get("anthropic"), undefined, {
      mainAgent: false,
    });
    const description = tools.find((tool) => tool.name === "Agent")?.description;

    expect(description).not.toContain("## When to fork");
    expect(description).not.toContain("Don't peek");
    expect(description).not.toContain("Don't race");
    expect(description).not.toContain("Writing a fork prompt");
    expect(description).toContain("## Background execution");
    expect(description).toContain("## Writing the prompt");
  });

  it("derives main-agent status from both request-context signals", () => {
    const mainDescription = assembledAgentDescription({});
    expect(mainDescription).toContain("## When to fork");
    expect(mainDescription).toContain("Don't peek");

    for (const ctxOverrides of [
      { agentOwnerId: "named-subagent" },
      { isForkChild: true },
    ] satisfies Partial<RequestContext>[]) {
      const subagentDescription = assembledAgentDescription(ctxOverrides);
      expect(subagentDescription).not.toContain("## When to fork");
      expect(subagentDescription).not.toContain("Don't peek");
      expect(subagentDescription).not.toContain("Don't race");
      expect(subagentDescription).not.toContain("Writing a fork prompt");
      expect(subagentDescription).toContain("## Background execution");
      expect(subagentDescription).toContain("## Writing the prompt");
    }
  });

  it("applies the same main-vs-subagent behavior to tier-aware descriptions", () => {
    const config = {
      ...DEFAULT_CONFIG,
      orchestrationMode: "feudalism" as const,
    };
    const mainDescription = assembledAgentDescription({}, config);
    const subagentDescription = assembledAgentDescription(
      { agentOwnerId: "named-subagent" },
      config,
    );

    expect(mainDescription).toContain("Multi-provider orchestration");
    expect(mainDescription).toContain("## When to fork");
    expect(mainDescription).toContain("Don't peek");
    expect(subagentDescription).toContain("Multi-provider orchestration");
    expect(subagentDescription).not.toContain("## When to fork");
    expect(subagentDescription).not.toContain("Don't peek");
    expect(subagentDescription).not.toContain("Don't race");
    expect(subagentDescription).not.toContain("Writing a fork prompt");
    expect(subagentDescription).toContain("## Background execution");
    expect(subagentDescription).toContain("## Writing the prompt");
  });

  it("drops announced MCP tools removed during a runtime refresh", () => {
    const retained = "mcp__playwright__navigate";
    const removed = "mcp__playwright__screenshot";
    clearDeferredAnnouncements();
    forceAnnounceDeferredTool(retained);
    forceAnnounceDeferredTool(removed, "fork-1");

    pruneAnnouncedMcpTools(new Set([retained]));

    expect(activeDeferredToolNames()).toEqual([retained]);
    expect(activeDeferredToolNames("fork-1")).toEqual([]);
  });

  it("omits blanket-denied active MCP schemas while retaining ask-only schemas", () => {
    const name = "mcp__github__delete_issue";
    const previousAnnouncements = activeDeferredToolNames();
    toolRegistry.registerWithNamespace("mcp:github", {
      schema: {
        name,
        description: "Delete a GitHub issue.",
        inputSchema: { type: "object", properties: {} },
      },
      async run(call) {
        return { tool_use_id: call.id, content: "" };
      },
    });
    announceDeferredTool(name);

    try {
      const askAndDeny = providerToolDeclarations(providers.get("anthropic"), undefined, {
        permissionRules: [
          {
            source: "userSettings",
            ruleBehavior: "ask",
            ruleValue: { toolName: name },
          },
          {
            source: "userSettings",
            ruleBehavior: "deny",
            ruleValue: { toolName: name },
          },
        ],
      });
      expect(askAndDeny.map((tool) => tool.name)).not.toContain(name);

      const askOnly = providerToolDeclarations(providers.get("anthropic"), undefined, {
        permissionRules: [
          {
            source: "userSettings",
            ruleBehavior: "ask",
            ruleValue: { toolName: name },
          },
        ],
      });
      expect(askOnly.map((tool) => tool.name)).toContain(name);
    } finally {
      toolRegistry.unregister(name);
      clearDeferredAnnouncements();
      for (const announcement of previousAnnouncements) forceAnnounceDeferredTool(announcement);
    }
  });
});
