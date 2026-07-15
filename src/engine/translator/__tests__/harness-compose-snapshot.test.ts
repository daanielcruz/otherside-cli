import { describe, expect, it } from "bun:test";
import { type LayerContext } from "@/harness/composer/injections.ts";
import { makeQueue } from "@/harness/composer/queue.ts";
import { compose, defaultStack } from "@/harness/composer.ts";
import { DEFAULT_CONFIG } from "@/kernel/config/config.ts";

function sampleContext(): LayerContext {
  return {
    provider: "anthropic",
    model: "claude-opus-4-8",
    effort: null,
    permissionMode: "default",
    sessionId: "sess-fixture",
    cwd: "/tmp/fixture",
    config: DEFAULT_CONFIG,
    multiproviderEnabled: false,
    mcpInstructionBlocks: [],
    injections: makeQueue(),
    deferredToolExclusions: new Set<string>(),
    emitDeferredReminder: true,
    emitAgentListing: true,
    supportsMidSystem: true,
    lean: false,
    modelFamily: "other" as const,
    currentDate: "2026-06-22",
    gitStatus: "On branch main",
    modelDisplayName: "Opus 4.8",
    modelTierLines: ["Best: Opus 4.8", "Explorer: Sonnet 4.6"],
    availableModels: [
      {
        provider: "codex",
        models: [
          { id: "gpt-5.6-sol", display: "GPT-5.6 Sol" },
          { id: "gpt-5.6-terra", display: "GPT-5.6 Terra" },
          { id: "gpt-5.6-luna", display: "GPT-5.6 Luna" },
        ],
      },
      {
        provider: "anthropic",
        models: [
          { id: "claude-fable-5", display: "Fable 5" },
          { id: "claude-opus-4-8", display: "Opus 4.8" },
          { id: "claude-sonnet-5", display: "Sonnet 5" },
          { id: "claude-haiku-4-5", display: "Haiku 4.5" },
        ],
      },
    ],
    knowledgeCutoff: "January 2026",
    agentRows: [
      {
        agentType: "Explore",
        whenToUse: "Read-only search agent",
        whenToUseLean: "Search agent",
        toolsLabel: "Read, Grep",
      },
      { agentType: "Plan", whenToUse: "Architect agent", toolsLabel: "*" },
    ],
    deferredToolNames: ["WebFetch", "WebSearch"],
    deferredMcpToolNames: ["mcp__demo__alpha", "mcp__demo__beta"],
    memorySection: "# otherside\nProject instructions here.",
    projectMemorySection: "# otherside\nProject instructions here.",
    skillListing: [
      { name: "verify", description: "Verify a change works.", builtin: true },
      { name: "loop", description: "Run a prompt on an interval.", builtin: false },
    ],
  };
}

function blockText(blocks: { text: string }[], match: string): string | undefined {
  return blocks.find((b) => b.text.includes(match))?.text;
}

describe("harness compose snapshot", () => {
  const ctx = sampleContext();
  const harness = compose(defaultStack(), ctx);
  const allBlocks = [
    ...harness.systemBlocks,
    ...(harness.midSystemBlocks ?? []),
    ...harness.userPrepend,
  ];

  it("env-info renders model description, cutoff, and tier line from ctx data", () => {
    const env = blockText(harness.systemBlocks, "# Environment");
    expect(env).toBeDefined();
    expect(env).toContain(
      " - You are powered by the model named Opus 4.8. The exact model ID is claude-opus-4-8.",
    );
    expect(env).toContain(" - Assistant knowledge cutoff is January 2026.");
    expect(env).toContain(
      " - Models on this provider, by tier — Best: Opus 4.8; Explorer: Sonnet 4.6. When building AI applications, default to the most capable (General tier) model.",
    );
    expect(env).toContain(
      " - otherside is available as a CLI in the terminal, with a companion mobile app (iOS/Android) for remote pairing and steering sessions on the go.",
    );
  });

  it("agent-listing renders ctx rows verbatim", () => {
    const agents = blockText(allBlocks, "Available agent types for the Agent tool:");
    expect(agents).toBe(
      "<system-reminder>\nAvailable agent types for the Agent tool:\n- Explore: Read-only search agent (Tools: Read, Grep)\n- Plan: Architect agent (Tools: *)\n\nWhen you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.\n</system-reminder>",
    );
  });

  it("skills reminder renders ctx skill listing", () => {
    const skills = blockText(allBlocks, "The following skills are available");
    expect(skills).toBe(
      "<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n- verify: Verify a change works.\n- loop: Run a prompt on an interval.\n</system-reminder>",
    );
  });

  it("deferred-tools reminder merges base + mcp names with exclusions honored", () => {
    const deferred = blockText(allBlocks, "The following deferred tools are now available");
    expect(deferred).toBe(
      '<system-reminder>\nThe following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\nWebFetch\nWebSearch\nmcp__demo__alpha\nmcp__demo__beta\n</system-reminder>',
    );
  });

  it("user-context renders memory and currentDate from ctx", () => {
    const user = blockText(harness.userPrepend, "# currentDate");
    expect(user).toBe(
      "# otherside\nProject instructions here.\n# currentDate\nToday's date is 2026-06-22.",
    );
  });

  it("gitStatus renders as a dynamic system block", () => {
    const git = blockText(
      [...harness.systemBlocks, ...(harness.midSystemBlocks ?? [])],
      "gitStatus:",
    );
    expect(git).toContain("gitStatus: On branch main");
  });
});
