import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { LayerContext } from "@/harness/composer/injections.ts";
import { HARNESS_MANIFEST } from "@/harness/composer/manifest.ts";
import { makeQueue } from "@/harness/composer/queue.ts";
import { compose, defaultStack } from "@/harness/composer.ts";
import { _setEnvInfoOverrideForTesting } from "@/harness/core/env-info.ts";
import { _setMemoryDirOverrideForTesting } from "@/harness/core/memory-guidance/memory-guidance.ts";
import { DEFAULT_CONFIG } from "@/kernel/config/config.ts";
import { getTrackedCwd, setTrackedCwd } from "@/kernel/std/state/cwd-state.ts";

let priorCwd: string;
let priorTrackedCwd: string;
let priorConfigDir: string | undefined;
let priorScratchpadDir: string | undefined;

function sampleContext(): LayerContext {
  return {
    provider: "anthropic",
    model: "claude-opus-4-8",
    effort: null,
    permissionMode: "default",
    sessionId: "sess-fixture",
    cwd: "/tmp/fixture",
    config: DEFAULT_CONFIG,
    orchestrationMode: "disabled",
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
    ],
    deferredToolNames: ["WebFetch", "WebSearch"],
    deferredMcpToolNames: ["mcp__demo__alpha"],
    memorySection: "# otherside\nProject instructions here.",
    projectMemorySection: "# otherside\nProject instructions here.",
    skillListing: [{ name: "verify", description: "Verify a change works.", builtin: true }],
  };
}

describe("harness composer purity and golden", () => {
  beforeEach(() => {
    priorCwd = process.cwd();
    priorConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    priorScratchpadDir = process.env.OTHERSIDE_SCRATCHPAD_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = "/__otherside_test_config__";
    process.env.OTHERSIDE_SCRATCHPAD_DIR = "/tmp/otherside-fixture/scratchpad";
    process.chdir("/");
    priorTrackedCwd = getTrackedCwd();
    setTrackedCwd("/workspace/project");
    _setEnvInfoOverrideForTesting({
      workspaceDir: "/workspace/project",
      isGitRepo: false,
      platform: "darwin",
      osVersion: "Darwin 0.0.0",
      shell: "bash",
    });
    _setMemoryDirOverrideForTesting("/__otherside_test_config__/projects/-/memory");
  });

  afterEach(() => {
    _setEnvInfoOverrideForTesting(null);
    _setMemoryDirOverrideForTesting(null);
    setTrackedCwd(priorTrackedCwd);
    process.chdir(priorCwd);
    if (priorConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = priorConfigDir;
    if (priorScratchpadDir === undefined) delete process.env.OTHERSIDE_SCRATCHPAD_DIR;
    else process.env.OTHERSIDE_SCRATCHPAD_DIR = priorScratchpadDir;
  });

  it("purity: static/undefined phase with render returns identical strings when called twice", () => {
    const ctx = sampleContext();
    Object.freeze(ctx);
    Object.freeze(ctx.config);

    for (const layer of HARNESS_MANIFEST) {
      const phase = layer.phase ?? "static";
      if (phase === "static" && layer.render) {
        const res1 = layer.render(ctx);
        const res2 = layer.render(ctx);
        expect(res1).toBe(res2);
      }
    }
  });

  it("golden: compose defaultStack across 24 matrix combos", () => {
    const base = sampleContext();
    const combos: Record<string, unknown> = {};
    for (const lean of [false, true]) {
      for (const orchestrationMode of ["disabled", "default", "feudalism"] as const) {
        for (const supportsMidSystem of [false, true]) {
          for (const gitStatus of [undefined, "On branch main"]) {
            const ctx = {
              ...base,
              lean,
              orchestrationMode,
              supportsMidSystem,
              injections: makeQueue(),
              ...(gitStatus !== undefined ? { gitStatus } : {}),
            };
            const h = compose(defaultStack(), ctx);
            const key = `lean=${lean}|mode=${orchestrationMode}|mid=${supportsMidSystem}|git=${gitStatus !== undefined}`;
            combos[key] = {
              systemBlocks: h.systemBlocks,
              userPrepend: h.userPrepend,
              midSystemBlocks: h.midSystemBlocks ?? [],
            };
          }
        }
      }
    }
    expect(combos).toMatchSnapshot();
  });
});
