import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveToolTierOverride } from "@/engine/background/subagents/dispatcher.ts";
import { DEEP_SECURITY_REVIEW_WORKFLOW } from "@/engine/background/workflows/bundled/deep-security-review.ts";
import {
  buildJournalSnapshot,
  type WorkflowJournalEntry,
  type WorkflowJournalStartedEntry,
} from "@/engine/background/workflows/runtime/history/journal.ts";
import { WORKFLOW_AGENT_SKIP_REASON } from "@/engine/background/workflows/runtime/store/types.ts";
import { defaultTierForAgentType } from "@/engine/model/tier/agent-defaults.ts";
import { setCredentialsLoaderForTests } from "@/engine/model/tier/resolver.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import {
  clearRoutingUsage,
  clearUsageLimits,
  setRoutingUsage,
} from "@/engine/session/usage/limits.ts";
import {
  clearProviderCooldowns,
  markProviderCooldown,
} from "@/engine/session/usage/provider-health.ts";
import workflowTool from "@/harness/tools/Workflow/tool.json" with { type: "json" };
import { isMultiproviderOrchestrationEnabled } from "@/kernel/config/config.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import type { CredentialsBundle } from "@/kernel/storage/credentials.ts";
import { computeAgentCacheKey, normalizeAgentCacheOptions } from "../agent-cache-key.ts";
import {
  readAgentOptions,
  renderWorkflowAgentSignature,
  WORKFLOW_AGENT_CACHE_KEYS,
} from "../agent-options.ts";
import {
  createWorkflowSubagentBridge,
  resolveEffectiveTier,
  resolveWorkflowAgentModelContext,
  resolveWorkflowAgentModelContextDetailed,
  setWorkflowForkRunnerForTests,
} from "../bridge.ts";

registerAllProviders();

function ctx(multiproviderEnabled: boolean): RequestContext {
  return ctxWith("codex", "gpt-5.5", multiproviderEnabled);
}

function ctxWith(
  provider: string,
  model: string,
  multiproviderEnabled = true,
  cwd = "/tmp",
): RequestContext {
  return {
    provider: provider as RequestContext["provider"],
    model,
    effort: null,
    permissionMode: "default",
    multiproviderEnabled,
    sessionId: "test-session",
    cwd,
  };
}

async function makeTempGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "otherside-wf-worktree-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  await writeFile(join(dir, "readme.txt"), "hello");
  execFileSync("git", ["add", "readme.txt"], { cwd: dir });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "init",
    ],
    { cwd: dir },
  );
  return dir;
}

function observeProvider(provider: Parameters<typeof setRoutingUsage>[0]): void {
  setRoutingUsage(provider, { trackingStatus: "untracked", balanceStatus: "unknown" });
}

function memoryJournal(seed: WorkflowJournalEntry[] = []): {
  appended: WorkflowJournalEntry[];
  journal: {
    append: (entry: WorkflowJournalEntry) => Promise<void>;
    results: ReturnType<typeof buildJournalSnapshot>["results"];
    started: ReturnType<typeof buildJournalSnapshot>["started"];
  };
} {
  const snapshot = buildJournalSnapshot(seed);
  const appended: WorkflowJournalEntry[] = [];
  return {
    appended,
    journal: {
      append: async (entry) => {
        appended.push(entry);
      },
      results: snapshot.results,
      started: snapshot.started,
    },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(1);
  expect(predicate()).toBe(true);
}

describe("readAgentOptions", () => {
  it("parses tier", () => {
    expect(readAgentOptions({ tier: "warrior" })).toMatchObject({ tier: "warrior" });
  });

  it("parses the diversify boolean and ignores non-boolean values", () => {
    expect(readAgentOptions({ tier: "warrior", diversify: true })).toMatchObject({
      tier: "warrior",
      diversify: true,
    });
    expect(readAgentOptions({ diversify: "yes" })).not.toHaveProperty("diversify");
  });

  it("parses model and effort while ignoring tierRank and unknown options", () => {
    const opts = readAgentOptions({
      tier: "warrior",
      model: "gpt-5.6-luna",
      effort: "high",
      tierRank: 2,
    });
    expect(opts).toMatchObject({ tier: "warrior", model: "gpt-5.6-luna", effort: "high" });
    expect(opts).not.toHaveProperty("tierRank");
  });

  it("ignores an invalid effort override", () => {
    expect(readAgentOptions({ effort: "ultra" })).not.toHaveProperty("effort");
  });
});

describe("WORKFLOW_AGENT_OPTIONS single source of truth", () => {
  it("renders a base signature that byte-matches the static Workflow tool.json", () => {
    // The one remaining coupling: the SoT renderer must agree with the static
    // asset the model sees when multiprovider is off. This guard fails loudly
    // if either drifts.
    expect(workflowTool.description).toContain(renderWorkflowAgentSignature(false));
  });

  it("keeps base options on both paths and adds provider/tier only for multiprovider", () => {
    const base = renderWorkflowAgentSignature(false);
    const multi = renderWorkflowAgentSignature(true);
    expect(base).toContain("model?: string");
    expect(base).toContain("effort?: string");
    expect(base).not.toContain("tier?:");
    expect(base).not.toContain("diversify?:");
    expect(base).not.toContain("provider?:");
    expect(multi).toContain("tier?: 'general' | 'warrior' | 'scout'");
    expect(multi).toContain("diversify?: boolean");
    expect(multi).toContain("model?: string");
    expect(multi).toContain("effort?: string");
    expect(multi).toContain("provider?: string");
  });

  it("cache keys cover the routing/output options and exclude cosmetic fields", () => {
    expect([...WORKFLOW_AGENT_CACHE_KEYS].sort()).toEqual([
      "agentType",
      "diversify",
      "effort",
      "isolation",
      "model",
      "provider",
      "schema",
      "tier",
    ]);
    expect(WORKFLOW_AGENT_CACHE_KEYS).not.toContain("label");
    expect(WORKFLOW_AGENT_CACHE_KEYS).not.toContain("phase");
  });
});

describe("normalizeAgentCacheOptions", () => {
  it("includes tier in workflow agent cache keys", () => {
    expect(normalizeAgentCacheOptions({ tier: "warrior" })).toBe(
      JSON.stringify({ tier: "warrior" }),
    );
  });

  it("includes model in workflow agent cache keys while ignoring tierRank", () => {
    expect(normalizeAgentCacheOptions({ tier: "warrior", model: "x", tierRank: 2 })).toBe(
      normalizeAgentCacheOptions({ tier: "warrior", model: "x" }),
    );
  });
});

describe("workflow agent runtime overrides", () => {
  it("passes model and effort overrides into the fork context", async () => {
    const captured: { model?: string; effort?: string | null } = {};
    const signal = new AbortController().signal;
    setWorkflowForkRunnerForTests(async (request) => {
      captured.model = request.ctx.model;
      captured.effort = request.ctx.effort;
      return { output: "ok", isError: false };
    });

    try {
      const bridge = await createWorkflowSubagentBridge({
        ctx: ctx(true),
        parentToolCallId: "parent-tool-call",
        runId: "wf-test-run",
        signal,
      });

      await bridge.agent("test prompt", { model: "custom-model", effort: "high" });

      expect(captured).toEqual({ model: "custom-model", effort: "high" });
    } finally {
      setWorkflowForkRunnerForTests(null);
    }
  });

  it("preserves the longest unchanged prefix in a sequential chain", async () => {
    const first = memoryJournal();
    setWorkflowForkRunnerForTests(async (request) => ({
      output: `cached ${request.prompt}`,
      isError: false,
    }));

    try {
      const initial = await createWorkflowSubagentBridge({
        ctx: ctx(true),
        parentToolCallId: "parent-tool-call",
        runId: "wf-sequential-seed",
        signal: new AbortController().signal,
        journal: first.journal,
      });
      await initial.agent("A");
      await initial.agent("B");
      await initial.agent("C");

      const seed = first.appended.filter(
        (entry) => !(entry.type === "result" && entry.result === "cached B"),
      );
      const resumedJournal = memoryJournal(seed);
      const promptsRun: string[] = [];
      setWorkflowForkRunnerForTests(async (request) => {
        promptsRun.push(request.prompt);
        return { output: `live ${request.prompt}`, isError: false };
      });
      const resumed = await createWorkflowSubagentBridge({
        ctx: ctx(true),
        parentToolCallId: "parent-tool-call",
        runId: "wf-sequential-resume",
        signal: new AbortController().signal,
        journal: resumedJournal.journal,
      });

      await expect(resumed.agent("A")).resolves.toBe("cached A");
      await expect(resumed.agent("B")).resolves.toBe("live B");
      await expect(resumed.agent("C")).resolves.toBe("live C");
      expect(promptsRun).toEqual(["B", "C"]);
    } finally {
      setWorkflowForkRunnerForTests(null);
    }
  });

  it("reuses one physical worktree across retries when isolation is worktree", async () => {
    // The #1 lifecycle guarantee: the owner creates ONE physical worktree and
    // hands the SAME handle to every retry, so a stall-retry runs against the
    // original snapshot instead of a worktree rebuilt from (possibly drifted)
    // source. Reused-path equality across both attempts is the proof.
    const capturedPaths: (string | undefined)[] = [];
    const signal = new AbortController().signal;
    const repoDir = await makeTempGitRepo();
    setWorkflowForkRunnerForTests(async (request) => {
      capturedPaths.push(request.worktree?.path);
      if (capturedPaths.length === 1) {
        return { output: "stall", isError: false, stalled: true };
      }
      return { output: "ok", isError: false };
    });

    try {
      const bridge = await createWorkflowSubagentBridge({
        ctx: ctxWith("codex", "gpt-5.5", true, repoDir),
        parentToolCallId: "parent-tool-call",
        runId: "wf-test-run",
        signal,
      });

      await bridge.agent("test prompt", { isolation: "worktree" });

      expect(capturedPaths.length).toBe(2);
      expect(capturedPaths[0]).toBeDefined();
      expect(capturedPaths[0]).toBe(capturedPaths[1]);
      expect(
        capturedPaths[0]?.endsWith(join(".otherside", "worktrees", "workflow-wf-test-run-1")),
      ).toBe(true);
    } finally {
      setWorkflowForkRunnerForTests(null);
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});

describe("workflow journal started records", () => {
  it("round-trips started entries into the started map", () => {
    const key = "v4:abc";
    const snapshot = buildJournalSnapshot([
      { type: "started", key, agentId: "agent-1" },
      { type: "started", key, agentId: "agent-2" },
      { type: "result", key: "v4:other", agentId: "agent-3", result: "ok" },
      { type: "meta", args: { x: 1 } },
    ]);
    expect(snapshot.started.get(key)?.map((entry) => entry.agentId)).toEqual([
      "agent-1",
      "agent-2",
    ]);
    expect(snapshot.results.has(key)).toBe(false);
    expect(snapshot.results.get("v4:other")?.result).toBe("ok");
    expect(snapshot.meta?.args).toEqual({ x: 1 });
  });

  it("logs a respawn notice on cache miss when the key was previously started", async () => {
    const logs: string[] = [];
    const keyA = computeAgentCacheKey("A", undefined, "root/agent:0", "");
    const prior: WorkflowJournalStartedEntry = {
      type: "started",
      key: keyA,
      agentId: "workflow-old-run-1",
    };
    setWorkflowForkRunnerForTests(async () => ({ output: "live A", isError: false }));
    try {
      const bridge = await createWorkflowSubagentBridge({
        ctx: ctx(true),
        parentToolCallId: "parent-tool-call",
        runId: "wf-respawn-run",
        signal: new AbortController().signal,
        log: (message) => logs.push(message),
        journal: {
          append: async () => {},
          results: new Map(),
          started: new Map([[keyA, [prior]]]),
        },
      });
      await expect(bridge.agent("A")).resolves.toBe("live A");
      expect(logs).toEqual([
        'respawning agent "A" — previous attempt started but never completed (1)',
      ]);
    } finally {
      setWorkflowForkRunnerForTests(null);
    }
  });

  it("does not log a respawn notice when the key was never started", async () => {
    const logs: string[] = [];
    setWorkflowForkRunnerForTests(async () => ({ output: "live", isError: false }));
    try {
      const bridge = await createWorkflowSubagentBridge({
        ctx: ctx(true),
        parentToolCallId: "parent-tool-call",
        runId: "wf-fresh-run",
        signal: new AbortController().signal,
        log: (message) => logs.push(message),
        journal: {
          append: async () => {},
          results: new Map(),
          started: new Map(),
        },
      });
      await expect(bridge.agent("fresh")).resolves.toBe("live");
      expect(logs).toEqual([]);
    } finally {
      setWorkflowForkRunnerForTests(null);
    }
  });
});

describe("workflow resume structural replay", () => {
  it("keeps parallel siblings independent when the middle branch misses", async () => {
    const first = memoryJournal();
    setWorkflowForkRunnerForTests(async (request) => ({
      output: `cached ${request.prompt}`,
      isError: false,
    }));
    try {
      const initial = await createWorkflowSubagentBridge({
        ctx: ctx(true),
        parentToolCallId: "parent",
        runId: "wf-parallel-seed",
        signal: new AbortController().signal,
        journal: first.journal,
      });
      await initial.parallel(["A", "B", "C"].map((prompt) => () => initial.agent(prompt)));

      const seed = first.appended.filter(
        (entry) => !(entry.type === "result" && entry.result === "cached B"),
      );
      const resumedJournal = memoryJournal(seed);
      const live: string[] = [];
      setWorkflowForkRunnerForTests(async (request) => {
        live.push(request.prompt);
        return { output: `live ${request.prompt}`, isError: false };
      });
      const resumed = await createWorkflowSubagentBridge({
        ctx: ctx(true),
        parentToolCallId: "parent",
        runId: "wf-parallel-resume",
        signal: new AbortController().signal,
        journal: resumedJournal.journal,
      });

      await expect(
        resumed.parallel(["A", "B", "C"].map((prompt) => () => resumed.agent(prompt))),
      ).resolves.toEqual(["cached A", "live B", "cached C"]);
      expect(live).toEqual(["B"]);
    } finally {
      setWorkflowForkRunnerForTests(null);
    }
  });

  it("keeps structural keys stable across opposite completion orders", async () => {
    const run = async (delays: Record<string, number>): Promise<Map<string, string>> => {
      const memory = memoryJournal();
      setWorkflowForkRunnerForTests(async (request) => {
        await Bun.sleep(delays[request.prompt] ?? 0);
        return { output: request.prompt, isError: false };
      });
      const bridge = await createWorkflowSubagentBridge({
        ctx: ctx(true),
        parentToolCallId: "parent",
        runId: "wf-order",
        signal: new AbortController().signal,
        journal: memory.journal,
      });
      await bridge.parallel(["A", "B", "C"].map((prompt) => () => bridge.agent(prompt)));
      return new Map(
        memory.appended
          .filter((entry) => entry.type === "result")
          .map((entry) => [String(entry.result), entry.key]),
      );
    };

    try {
      const slowA = await run({ A: 20, B: 10, C: 0 });
      const slowC = await run({ A: 0, B: 10, C: 20 });
      expect(slowA).toEqual(slowC);
      expect(new Set(slowA.values()).size).toBe(3);
    } finally {
      setWorkflowForkRunnerForTests(null);
    }
  });

  it("isolates pipeline items while preserving stage dependency", async () => {
    const execute = async (bridge: Awaited<ReturnType<typeof createWorkflowSubagentBridge>>) =>
      bridge.pipeline(
        ["x", "y"],
        (_value: unknown, item: unknown) => bridge.agent(`${item}:s1`),
        (value: unknown) => bridge.agent(`${value}:s2`),
      );
    const first = memoryJournal();
    setWorkflowForkRunnerForTests(async (request) => ({ output: request.prompt, isError: false }));
    try {
      const initial = await createWorkflowSubagentBridge({
        ctx: ctx(true),
        parentToolCallId: "parent",
        runId: "wf-pipeline-seed",
        signal: new AbortController().signal,
        journal: first.journal,
      });
      await execute(initial);

      const seed = first.appended.filter(
        (entry) => !(entry.type === "result" && entry.result === "x:s1"),
      );
      const resumedJournal = memoryJournal(seed);
      const live: string[] = [];
      setWorkflowForkRunnerForTests(async (request) => {
        live.push(request.prompt);
        return { output: request.prompt, isError: false };
      });
      const resumed = await createWorkflowSubagentBridge({
        ctx: ctx(true),
        parentToolCallId: "parent",
        runId: "wf-pipeline-resume",
        signal: new AbortController().signal,
        journal: resumedJournal.journal,
      });

      await expect(execute(resumed)).resolves.toEqual(["x:s1:s2", "y:s1:s2"]);
      expect(live).toEqual(["x:s1", "x:s1:s2"]);
    } finally {
      setWorkflowForkRunnerForTests(null);
    }
  });

  it("composes parallel to pipeline paths without cross-branch invalidation", async () => {
    const execute = async (bridge: Awaited<ReturnType<typeof createWorkflowSubagentBridge>>) =>
      bridge.parallel(
        ["left", "right"].map(
          (item) => () =>
            bridge.pipeline(
              [item],
              (_value: unknown, original: unknown) => bridge.agent(`${original}:s1`),
              (value: unknown) => bridge.agent(`${value}:s2`),
            ),
        ),
      );
    const first = memoryJournal();
    setWorkflowForkRunnerForTests(async (request) => ({ output: request.prompt, isError: false }));
    try {
      const initial = await createWorkflowSubagentBridge({
        ctx: ctx(true),
        parentToolCallId: "parent",
        runId: "wf-nest-pp-seed",
        signal: new AbortController().signal,
        journal: first.journal,
      });
      await execute(initial);
      const seed = first.appended.filter(
        (entry) => !(entry.type === "result" && entry.result === "right:s1"),
      );
      const resumedJournal = memoryJournal(seed);
      const live: string[] = [];
      setWorkflowForkRunnerForTests(async (request) => {
        live.push(request.prompt);
        return { output: request.prompt, isError: false };
      });
      const resumed = await createWorkflowSubagentBridge({
        ctx: ctx(true),
        parentToolCallId: "parent",
        runId: "wf-nest-pp-resume",
        signal: new AbortController().signal,
        journal: resumedJournal.journal,
      });

      await execute(resumed);
      expect(live).toEqual(["right:s1", "right:s1:s2"]);
    } finally {
      setWorkflowForkRunnerForTests(null);
    }
  });

  it("composes pipeline to parallel paths and invalidates only the dependent item", async () => {
    const execute = async (bridge: Awaited<ReturnType<typeof createWorkflowSubagentBridge>>) =>
      bridge.pipeline(
        ["left", "right"],
        async (_value: unknown, item: unknown) =>
          bridge.parallel(["a", "b"].map((suffix) => () => bridge.agent(`${item}:${suffix}`))),
        (value: unknown, item: unknown) => bridge.agent(`${item}:judge:${JSON.stringify(value)}`),
      );
    const first = memoryJournal();
    setWorkflowForkRunnerForTests(async (request) => ({ output: request.prompt, isError: false }));
    try {
      const initial = await createWorkflowSubagentBridge({
        ctx: ctx(true),
        parentToolCallId: "parent",
        runId: "wf-nest-ppl-seed",
        signal: new AbortController().signal,
        journal: first.journal,
      });
      await execute(initial);
      const seed = first.appended.filter(
        (entry) => !(entry.type === "result" && entry.result === "right:b"),
      );
      const resumedJournal = memoryJournal(seed);
      const live: string[] = [];
      setWorkflowForkRunnerForTests(async (request) => {
        live.push(request.prompt);
        return { output: request.prompt, isError: false };
      });
      const resumed = await createWorkflowSubagentBridge({
        ctx: ctx(true),
        parentToolCallId: "parent",
        runId: "wf-nest-ppl-resume",
        signal: new AbortController().signal,
        journal: resumedJournal.journal,
      });

      await execute(resumed);
      expect(live).toEqual(["right:b", 'right:judge:["right:a","right:b"]']);
    } finally {
      setWorkflowForkRunnerForTests(null);
    }
  });

  it("reuses completed siblings after a partially aborted parallel batch", async () => {
    const controller = new AbortController();
    const first = memoryJournal();
    setWorkflowForkRunnerForTests(async (request) => {
      if (request.prompt !== "A") await Bun.sleep(20);
      return { output: `done ${request.prompt}`, isError: false };
    });
    try {
      const initial = await createWorkflowSubagentBridge({
        ctx: ctx(true),
        parentToolCallId: "parent",
        runId: "wf-abort-partial",
        signal: controller.signal,
        journal: first.journal,
        onAgentEvent: (event) => {
          if (event.state === "done" && event.prompt === "A") controller.abort();
        },
      });
      await initial.parallel(["A", "B", "C"].map((prompt) => () => initial.agent(prompt)));
      expect(
        first.appended.filter((entry) => entry.type === "result").map((entry) => entry.result),
      ).toEqual(["done A"]);

      const resumedJournal = memoryJournal(first.appended);
      const live: string[] = [];
      setWorkflowForkRunnerForTests(async (request) => {
        live.push(request.prompt);
        return { output: `resumed ${request.prompt}`, isError: false };
      });
      const resumed = await createWorkflowSubagentBridge({
        ctx: ctx(true),
        parentToolCallId: "parent",
        runId: "wf-abort-resume",
        signal: new AbortController().signal,
        journal: resumedJournal.journal,
      });

      await expect(
        resumed.parallel(["A", "B", "C"].map((prompt) => () => resumed.agent(prompt))),
      ).resolves.toEqual(["done A", "resumed B", "resumed C"]);
      expect(live).toEqual(["B", "C"]);
    } finally {
      setWorkflowForkRunnerForTests(null);
    }
  });

  it("does not emit done until the result append resolves", async () => {
    let releaseAppend: (() => void) | undefined;
    let resultAppendStarted = false;
    const blocked = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const events: string[] = [];
    const snapshot = buildJournalSnapshot([]);
    setWorkflowForkRunnerForTests(async () => ({ output: "durable", isError: false }));
    try {
      const bridge = await createWorkflowSubagentBridge({
        ctx: ctx(true),
        parentToolCallId: "parent",
        runId: "wf-durable-done",
        signal: new AbortController().signal,
        onAgentEvent: (event) => events.push(event.state),
        journal: {
          results: snapshot.results,
          started: snapshot.started,
          append: async (entry) => {
            if (entry.type !== "result") return;
            resultAppendStarted = true;
            await blocked;
          },
        },
      });
      const pending = bridge.agent("A");
      await waitUntil(() => resultAppendStarted);
      expect(events).not.toContain("done");
      releaseAppend?.();
      await expect(pending).resolves.toBe("durable");
      expect(events.at(-1)).toBe("done");
    } finally {
      setWorkflowForkRunnerForTests(null);
    }
  });

  it("never caches null, terminal errors, or user skips", async () => {
    const memory = memoryJournal();
    setWorkflowForkRunnerForTests(async (request) => {
      if (request.prompt === "null") return { output: "provider failed", isError: true };
      if (request.prompt === "error") {
        return { output: "StructuredOutputMismatchError: invalid", isError: true };
      }
      return { output: "skipped output", isError: false };
    });
    try {
      const bridge = await createWorkflowSubagentBridge({
        ctx: ctx(true),
        parentToolCallId: "parent",
        runId: "wf-no-null-cache",
        signal: new AbortController().signal,
        journal: memory.journal,
        onAgentController: (agentId, agentController) => {
          if (agentId.endsWith("-3")) agentController?.abort(WORKFLOW_AGENT_SKIP_REASON);
        },
      });

      await expect(bridge.agent("null")).resolves.toBeNull();
      await expect(bridge.agent("error", { schema: {} })).rejects.toThrow(
        "StructuredOutputMismatchError",
      );
      await expect(bridge.agent("skip")).resolves.toBeNull();
      expect(memory.appended.filter((entry) => entry.type === "result")).toEqual([]);
      expect(memory.appended.filter((entry) => entry.type === "started")).toHaveLength(3);
    } finally {
      setWorkflowForkRunnerForTests(null);
    }
  });
});

describe("defaultTierForAgentType map", () => {
  it("routes recon/search to scout", () => {
    expect(defaultTierForAgentType("recon")).toBe("scout");
    expect(defaultTierForAgentType("search")).toBe("scout");
  });

  it("routes broad exploration to warrior (tier 2)", () => {
    expect(defaultTierForAgentType("explore")).toBe("warrior");
    expect(defaultTierForAgentType("code-explorer")).toBe("warrior");
  });

  it("routes plan/architect to general", () => {
    expect(defaultTierForAgentType("plan")).toBe("general");
    expect(defaultTierForAgentType("ui-architect")).toBe("general");
  });

  it("routes review/verify/audit to warrior", () => {
    expect(defaultTierForAgentType("security-reviewer")).toBe("warrior");
    expect(defaultTierForAgentType("verifier")).toBe("warrior");
  });

  it("falls back to warrior for unknown or missing types (case-insensitive)", () => {
    expect(defaultTierForAgentType("general-purpose")).toBe("warrior");
    expect(defaultTierForAgentType("EXPLORER")).toBe("warrior");
    expect(defaultTierForAgentType(undefined)).toBe("warrior");
  });
});

describe("resolveEffectiveTier", () => {
  it("returns an explicit tier verbatim", () => {
    expect(resolveEffectiveTier(ctx(true), { tier: "general", agentType: "explore" })).toBe(
      "general",
    );
  });

  it("infers tier from agentType when multiprovider is on and tier is omitted", () => {
    expect(resolveEffectiveTier(ctx(true), { agentType: "explore" })).toBe("warrior");
  });

  it("does not infer a tier when multiprovider is off (agent inherits parent)", () => {
    expect(resolveEffectiveTier(ctx(false), { agentType: "explore" })).toBeUndefined();
  });

  it("returns undefined with neither tier nor agentType", () => {
    expect(resolveEffectiveTier(ctx(true), {})).toBeUndefined();
  });
});

describe("resolveWorkflowAgentModelContext gating", () => {
  it("rejects tier when multi-provider orchestration is disabled", () => {
    const resolved = resolveWorkflowAgentModelContext(ctx(false), { tier: "warrior" });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected rejection");
    expect(resolved.error).toContain("requires multi-provider orchestration");
  });

  it("rejects an unknown tier name with general/warrior/scout", () => {
    const resolved = resolveWorkflowAgentModelContext(ctx(true), { tier: "best" });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected rejection");
    expect(resolved.error).toBe(
      "InputValidationError: tier must be one of: general, warrior, scout.",
    );
  });

  it("inherits the parent model when no tier is set", () => {
    const resolved = resolveWorkflowAgentModelContext(ctx(true), {});
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.error);
    expect(resolved.ctx.model).toBe("gpt-5.5");
  });
});

describe("isMultiproviderOrchestrationEnabled", () => {
  it("is off when orchestratorMode is off even if tierSelectorEnabled is true", () => {
    expect(
      isMultiproviderOrchestrationEnabled({ tierSelectorEnabled: true, orchestratorMode: "off" }),
    ).toBe(false);
  });

  it("is on for orchestratorMode soft even without tierSelectorEnabled", () => {
    expect(isMultiproviderOrchestrationEnabled({ orchestratorMode: "soft" })).toBe(true);
  });

  it("defaults to off when config is undefined", () => {
    expect(isMultiproviderOrchestrationEnabled(undefined)).toBe(false);
  });
});

describe("deep-security-review bundled script static analysis", () => {
  it("does not hardcode warrior rank 2/3 for auditors", () => {
    const script = DEEP_SECURITY_REVIEW_WORKFLOW.script;
    expect(script).not.toContain("tierRank: currentRank");
    expect(script).not.toContain("rankCounter");
    expect(script).not.toContain("currentRank = (rankCounter");
  });
});

describe("degradedRouting formatting", () => {
  it("formats degradedRouting in formatWorkflowTaskOutput", () => {
    const { formatWorkflowTaskOutput } = require("../../store/output.ts");
    const fakeTask = {
      title: "Test Workflow",
      workflowName: "test-wf",
      workflowRunId: "wf-123",
      status: "completed",
      logs: [],
      degradedRouting: ["Fewer workers available", "Fallback to default"],
    };
    const output = formatWorkflowTaskOutput(fakeTask);
    expect(output).toContain("Degraded Routing:");
    expect(output).toContain("- Fewer workers available");
    expect(output).toContain("- Fallback to default");
  });
});

describe("resolveWorkflowAgentModelContextDetailed", () => {
  // Hermetic: inject a credentials bundle with only the active provider (codex)
  // configured and reset process-global routing/cooldown state, so these
  // assertions do not depend on the host machine's real ~/.otherside credentials.
  const onlyCodexCreds = (): CredentialsBundle =>
    ({ codex: { accessToken: "test" } }) as unknown as CredentialsBundle;
  const codexAndAnthropicCreds = (): CredentialsBundle =>
    ({
      anthropic: { accessToken: "test" },
      codex: { accessToken: "test" },
    }) as unknown as CredentialsBundle;
  const scoutCreds = (): CredentialsBundle =>
    ({
      anthropic: { accessToken: "test" },
      antigravity: { accessToken: "test" },
      glm: { zcodeJwtToken: "test" },
    }) as unknown as CredentialsBundle;

  beforeEach(() => {
    clearRoutingUsage();
    clearUsageLimits();
    clearProviderCooldowns();
    setCredentialsLoaderForTests(onlyCodexCreds);
  });

  afterEach(() => {
    setCredentialsLoaderForTests(null);
    clearRoutingUsage();
    clearUsageLimits();
    clearProviderCooldowns();
  });

  it("returns degradedReasons when cascading / falling back", () => {
    // Caller is on a warrior model (gpt-5.6-luna), so routing to general is a
    // genuine cross-tier resolution (no self-inherit). Only codex is
    // credentialed, so the general pool is degraded (1 usable of many).
    const context = ctxWith("codex", "gpt-5.6-luna");
    const resolved = resolveWorkflowAgentModelContextDetailed(context, { tier: "general" });
    expect(resolved.ok).toBe(true);
    expect(resolved.ctx.model).toBe("gpt-5.6-sol");
    expect(resolved.degradedReasons).toBeDefined();
    expect(resolved.degradedReasons!.length).toBeGreaterThan(0);
  });

  it("inherits the caller's own model only when it already belongs to the tier and is usable", () => {
    setCredentialsLoaderForTests(codexAndAnthropicCreds);
    const context = ctxWith("anthropic", "claude-opus-4-8");
    const resolved = resolveWorkflowAgentModelContextDetailed(context, { tier: "general" });
    expect(resolved.ok).toBe(true);
    expect(resolved.ctx.provider).toBe("anthropic");
    expect(resolved.ctx.model).toBe("claude-opus-4-8");
    expect(resolved.degradedReasons).toBeUndefined();
  });

  it("falls back when the caller's in-tier provider is not usable", () => {
    const context = ctxWith("anthropic", "claude-opus-4-8");
    const resolved = resolveWorkflowAgentModelContextDetailed(context, { tier: "general" });
    expect(resolved.ok).toBe(true);
    expect(resolved.ctx.provider).toBe("codex");
    expect(resolved.ctx.model).toBe("gpt-5.6-sol");
    expect(resolved.degradedReasons).toBeDefined();
  });

  it("diversify ignores self-inherit and spreads across the tier roster", () => {
    // Same in-tier caller, but diversify wants divergent models — so it must
    // resolve through the roster (here only codex is credentialed and usage-observed)
    // instead of self.
    observeProvider("codex");
    const context = ctxWith("anthropic", "claude-opus-4-8");
    const resolved = resolveWorkflowAgentModelContextDetailed(context, {
      tier: "general",
      diversify: true,
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.ctx.provider).toBe("codex");
    expect(resolved.ctx.model).toBe("gpt-5.6-sol");
  });

  it("skips an exhausted-balance active parent and selects the next usable rank", () => {
    setCredentialsLoaderForTests(scoutCreds);
    setRoutingUsage("anthropic", { trackingStatus: "untracked", balanceStatus: "exhausted" });
    const context = ctxWith("anthropic", "claude-haiku-4-5");
    const resolved = resolveWorkflowAgentModelContextDetailed(context, { tier: "scout" });
    expect(resolved.ok).toBe(true);
    expect(resolved.ctx.provider).toBe("antigravity");
    expect(resolved.ctx.model).toBe("gemini-3-flash-medium");
  });

  it("skips a cooled-down scout rank-1 parent and selects the next usable rank", () => {
    setCredentialsLoaderForTests(scoutCreds);
    markProviderCooldown("antigravity", Date.now() + 60_000, "rate_limited");
    const context = ctxWith("antigravity", "gemini-3-flash-medium");
    const resolved = resolveWorkflowAgentModelContextDetailed(context, { tier: "scout" });
    expect(resolved.ok).toBe(true);
    expect(resolved.ctx.provider).toBe("anthropic");
    expect(resolved.ctx.model).toBe("claude-haiku-4-5");
  });

  it("diversify excludes a cooled-down rank-1 provider from round-robin", () => {
    setCredentialsLoaderForTests(scoutCreds);
    // A runtime cooldown drops the active provider from the spread, same as any
    // other member — there is no active-provider exemption.
    markProviderCooldown("anthropic", Date.now() + 60_000, "rate_limited");
    const context = ctxWith("anthropic", "claude-haiku-4-5");
    const first = resolveWorkflowAgentModelContextDetailed(
      context,
      { tier: "scout", diversify: true },
      {
        allocationCount: 0,
      },
    );
    const second = resolveWorkflowAgentModelContextDetailed(
      context,
      { tier: "scout", diversify: true },
      {
        allocationCount: 1,
      },
    );
    expect(first.ctx.provider).toBe("antigravity");
    expect(second.ctx.provider).toBe("glm");
  });

  it("diversify excludes an exhausted-balance active provider from the spread", () => {
    setCredentialsLoaderForTests(scoutCreds);
    // Exhausted balance drops the active provider like any other member — the
    // round-robin spreads across the remaining usable roster only.
    setRoutingUsage("anthropic", { trackingStatus: "untracked", balanceStatus: "exhausted" });
    const context = ctxWith("anthropic", "claude-haiku-4-5");
    const first = resolveWorkflowAgentModelContextDetailed(
      context,
      { tier: "scout", diversify: true },
      { allocationCount: 0 },
    );
    const second = resolveWorkflowAgentModelContextDetailed(
      context,
      { tier: "scout", diversify: true },
      { allocationCount: 1 },
    );
    expect(first.ctx.provider).toBe("antigravity");
    expect(second.ctx.provider).toBe("glm");
  });

  it("pins the run's tier pool so it does not flap when a higher-rank provider recovers", () => {
    setCredentialsLoaderForTests(scoutCreds);
    // Caller is on a general model, so scout is a cross-tier resolve (top-N pool).
    const context = ctxWith("anthropic", "claude-opus-4-8");
    // Scout rank-1 (antigravity) is cooled down, so the run's first agent
    // resolves to the next usable rank.
    markProviderCooldown("antigravity", Date.now() + 60_000, "rate_limited");
    const first = resolveWorkflowAgentModelContextDetailed(context, { tier: "scout" });
    expect(first.ctx.provider).toBe("anthropic");
    expect(first.selectedPool?.[0]?.provider).toBe("anthropic");
    // Rank-1 recovers. A fresh (non-pinned) resolve would flap back to antigravity;
    // the pinned run stays on the lower rank because the pinned entry is still usable.
    clearProviderCooldowns();
    const fresh = resolveWorkflowAgentModelContextDetailed(context, { tier: "scout" });
    expect(fresh.ctx.provider).toBe("antigravity");
    const pinned = resolveWorkflowAgentModelContextDetailed(
      context,
      { tier: "scout" },
      { allocationCount: 1 },
      first.selectedPool,
    );
    expect(pinned.ctx.provider).toBe("anthropic");
  });

  it("drops a newly blocked member from a pinned diversify pool", () => {
    setCredentialsLoaderForTests(scoutCreds);
    const context = ctxWith("anthropic", "claude-opus-4-8");
    const first = resolveWorkflowAgentModelContextDetailed(
      context,
      { tier: "scout", diversify: true },
      { allocationCount: 0 },
    );
    expect(first.ok).toBe(true);
    expect(first.selectedPool?.some((entry) => entry.provider === "antigravity")).toBe(true);

    markProviderCooldown("antigravity", null, "rate_limited");
    const next = resolveWorkflowAgentModelContextDetailed(
      context,
      { tier: "scout", diversify: true },
      { allocationCount: 0 },
      first.selectedPool,
    );
    expect(next.ok).toBe(true);
    expect(next.ctx.provider).not.toBe("antigravity");
    expect(next.selectedPool?.some((entry) => entry.provider === "antigravity")).toBe(false);
  });

  it("direct Agent bare tier skips an exhausted-balance in-tier parent", () => {
    setCredentialsLoaderForTests(scoutCreds);
    setRoutingUsage("anthropic", { trackingStatus: "untracked", balanceStatus: "exhausted" });
    const resolved = resolveToolTierOverride(ctxWith("anthropic", "claude-haiku-4-5"), "scout");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.error);
    expect(resolved.ctx.provider).toBe("antigravity");
    expect(resolved.ctx.model).toBe("gemini-3-flash-medium");
  });

  it("direct Agent bare tier skips a cooled-down in-tier parent", () => {
    setCredentialsLoaderForTests(scoutCreds);
    markProviderCooldown("antigravity", Date.now() + 60_000, "rate_limited");
    const resolved = resolveToolTierOverride(
      ctxWith("antigravity", "gemini-3-flash-medium"),
      "scout",
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.error);
    expect(resolved.ctx.provider).toBe("anthropic");
    expect(resolved.ctx.model).toBe("claude-haiku-4-5");
  });

  it("direct Agent strict rank remains strict when the rank provider is cooled down", () => {
    setCredentialsLoaderForTests(scoutCreds);
    // A cooldown drops the active rank-1 provider; strict rank must fail rather
    // than compact to rank 2.
    markProviderCooldown("antigravity", Date.now() + 60_000, "rate_limited");
    const resolved = resolveToolTierOverride(
      ctxWith("antigravity", "gemini-3-flash-medium"),
      "scout",
      1,
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected strict rank failure");
    expect(resolved.error).toContain("rank 1");
    expect(resolved.error).toContain("unavailable");
  });

  it("Workflow: skips antigravity when exhausted and selects it when available", () => {
    setCredentialsLoaderForTests(scoutCreds);
    const context = ctxWith("anthropic", "claude-opus-4-8");

    setRoutingUsage("antigravity", {
      trackingStatus: "tracked",
      balanceStatus: "exhausted",
      utilizationPct: 100,
    });

    const first = resolveWorkflowAgentModelContextDetailed(context, { tier: "scout" });
    expect(first.ok).toBe(true);
    expect(first.ctx.provider).not.toBe("antigravity");

    setRoutingUsage("antigravity", {
      trackingStatus: "tracked",
      balanceStatus: "available",
      utilizationPct: 10,
    });

    const second = resolveWorkflowAgentModelContextDetailed(context, { tier: "scout" });
    expect(second.ok).toBe(true);
    expect(second.ctx.provider).toBe("antigravity");
  });

  it("direct Agent: skips antigravity when exhausted and selects it when available", () => {
    setCredentialsLoaderForTests(scoutCreds);
    const context = ctxWith("anthropic", "claude-opus-4-8");

    setRoutingUsage("antigravity", {
      trackingStatus: "tracked",
      balanceStatus: "exhausted",
      utilizationPct: 100,
    });

    const first = resolveToolTierOverride(context, "scout");
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    expect(first.ctx.provider).not.toBe("antigravity");

    setRoutingUsage("antigravity", {
      trackingStatus: "tracked",
      balanceStatus: "available",
      utilizationPct: 10,
    });

    const second = resolveToolTierOverride(context, "scout");
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error);
    expect(second.ctx.provider).toBe("antigravity");
  });

  it("Agent and Workflow with same state choose same lower tier", () => {
    setCredentialsLoaderForTests(
      () =>
        ({
          anthropic: { accessToken: "test" },
          codex: { accessToken: "test" },
          glm: { zcodeJwtToken: "test" },
          antigravity: { accessToken: "test" },
          "kimi-code": { apiKey: "test" },
          deepseek: { apiKey: "test" },
          minimax: { apiKey: "test" },
        }) as unknown as CredentialsBundle,
    );

    markProviderCooldown("codex", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("anthropic", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("glm", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("antigravity", Date.now() + 60_000, "rate_limited");

    observeProvider("antigravity");
    observeProvider("codex");

    const context = ctxWith("codex", "gpt-5.5");

    const wfRes = resolveWorkflowAgentModelContextDetailed(context, { tier: "general" });
    expect(wfRes.ok).toBe(true);

    const agentRes = resolveToolTierOverride(context, "general");
    expect(agentRes.ok).toBe(true);
    if (!agentRes.ok) throw new Error("Agent resolution failed");

    expect(wfRes.ctx.provider).toBe(agentRes.ctx.provider);
    expect(wfRes.ctx.model).toBe(agentRes.ctx.model);
    expect(wfRes.ctx.provider).toBe("deepseek");
  });

  it("Workflow diversify does not mix tiers", () => {
    setCredentialsLoaderForTests(
      () =>
        ({
          anthropic: { accessToken: "test" },
          codex: { accessToken: "test" },
          glm: { zcodeJwtToken: "test" },
          antigravity: { accessToken: "test" },
          "kimi-code": { apiKey: "test" },
          deepseek: { apiKey: "test" },
          minimax: { apiKey: "test" },
        }) as unknown as CredentialsBundle,
    );

    markProviderCooldown("codex", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("anthropic", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("glm", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("antigravity", Date.now() + 60_000, "rate_limited");

    observeProvider("antigravity");
    observeProvider("codex");

    const context = ctxWith("codex", "gpt-5.5");
    const wfRes = resolveWorkflowAgentModelContextDetailed(context, {
      tier: "general",
      diversify: true,
    });
    expect(wfRes.ok).toBe(true);
    expect(wfRes.selectedPool).toBeDefined();

    for (const resolution of wfRes.selectedPool!) {
      expect(resolution.provider).not.toBe("anthropic");
      const isWarrior = [
        "gemini-3-flash",
        "gpt-5.6-terra",
        "claude-sonnet-5",
        "grok-composer-2.5-fast",
        "glm-5-turbo",
        "deepseek-v4-flash",
        "kimi-for-coding",
        "minimax-m3",
      ].includes(resolution.model);
      expect(isWarrior).toBe(true);
    }
  });

  it("quotaFallbackEnabled:false + diversify fails when skipping quota candidates", () => {
    setCredentialsLoaderForTests(
      () =>
        ({
          anthropic: { accessToken: "test" },
          codex: { accessToken: "test" },
          glm: { zcodeJwtToken: "test" },
          antigravity: { accessToken: "test" },
          "kimi-code": { apiKey: "test" },
          deepseek: { apiKey: "test" },
          minimax: { apiKey: "test" },
        }) as unknown as CredentialsBundle,
    );

    setRoutingUsage("codex", { trackingStatus: "tracked", utilizationPct: 100 });
    markProviderCooldown("anthropic", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("glm", Date.now() + 60_000, "rate_limited");
    markProviderCooldown("antigravity", Date.now() + 60_000, "rate_limited");

    const context = {
      ...ctxWith("anthropic", "claude-opus-4-8"),
      quotaFallbackEnabled: false,
    };

    const wfRes = resolveWorkflowAgentModelContextDetailed(context, {
      tier: "general",
      diversify: true,
    });
    expect(wfRes.ok).toBe(false);
    if (wfRes.ok) throw new Error("expected workflow fallback failure");
    expect(wfRes.error).toContain("Quota fallback is disabled");
  });

  it("both use active route when all tier candidates are unavailable but openai-custom active is usable", () => {
    for (const p of [
      "codex",
      "anthropic",
      "glm",
      "antigravity",
      "deepseek",
      "kimi-code",
      "minimax",
    ]) {
      markProviderCooldown(p as ProviderId, Date.now() + 60_000, "rate_limited");
    }

    setCredentialsLoaderForTests(
      () =>
        ({
          "openai-custom": { apiKey: "test-key" },
        }) as unknown as CredentialsBundle,
    );

    const context = ctxWith("openai-custom", "custom-model");

    const agentRes = resolveToolTierOverride(context, "general");
    expect(agentRes.ok).toBe(true);
    if (!agentRes.ok) throw new Error("Agent resolution failed");
    expect(agentRes.ctx.provider).toBe("openai-custom");
    expect(agentRes.ctx.model).toBe("custom-model");
    expect(agentRes.routingNotice).toBe(
      `No usable provider found in tier cascade "general"; using the active route openai-custom/custom-model.`,
    );

    const wfRes = resolveWorkflowAgentModelContextDetailed(context, { tier: "general" });
    expect(wfRes.ok).toBe(true);
    expect(wfRes.ctx.provider).toBe("openai-custom");
    expect(wfRes.ctx.model).toBe("custom-model");
    expect(wfRes.degradedReasons).toBeDefined();
    expect(wfRes.degradedReasons![0]).toContain(
      `No usable provider found in tier cascade "general"; using the active route openai-custom/custom-model. Diagnostics:`,
    );
  });

  it("active route unavailable fails when all tier candidates are also unavailable", () => {
    for (const p of [
      "codex",
      "anthropic",
      "glm",
      "antigravity",
      "deepseek",
      "kimi-code",
      "minimax",
    ]) {
      markProviderCooldown(p as ProviderId, Date.now() + 60_000, "rate_limited");
    }

    setCredentialsLoaderForTests(() => ({}) as unknown as CredentialsBundle);

    const context = ctxWith("openai-custom", "custom-model");

    const agentRes = resolveToolTierOverride(context, "general");
    expect(agentRes.ok).toBe(false);

    const wfRes = resolveWorkflowAgentModelContextDetailed(context, { tier: "general" });
    expect(wfRes.ok).toBe(false);
  });
});

describe("bridge inherited route quota refusal", () => {
  beforeEach(() => {
    clearRoutingUsage();
    clearProviderCooldowns();
    setCredentialsLoaderForTests(
      () => ({ codex: { accessToken: "test" } }) as unknown as CredentialsBundle,
    );
  });

  afterEach(() => {
    setWorkflowForkRunnerForTests(null);
    setCredentialsLoaderForTests(null);
    clearRoutingUsage();
    clearProviderCooldowns();
  });

  it("rejects a no-tier agent launch when the inherited provider is exhausted", async () => {
    setRoutingUsage("codex", {
      trackingStatus: "tracked",
      utilizationPct: 40,
      balanceStatus: "exhausted",
    });
    let dispatchCount = 0;
    setWorkflowForkRunnerForTests(async () => {
      dispatchCount += 1;
      return { output: "unexpected dispatch", isError: false };
    });
    const bridge = await createWorkflowSubagentBridge({
      ctx: ctx(true),
      parentToolCallId: "parent-tool-call",
      runId: "wf-inherited-quota",
      signal: new AbortController().signal,
    });

    await expect(bridge.agent("test prompt")).rejects.toThrow(
      'QuotaExhaustedError: provider "codex"',
    );
    expect(dispatchCount).toBe(0);
  });
});

describe("bridge error throwing / no fallback on schema/tool errors", () => {
  it("throws VM safe errors for subagent execution errors", async () => {
    setWorkflowForkRunnerForTests(async () => {
      return {
        output: "StructuredOutputMismatchError: Schema validation failed. missing fields",
        isError: true,
      };
    });

    const signal = new AbortController().signal;
    const bridge = await createWorkflowSubagentBridge({
      ctx: ctx(true),
      parentToolCallId: "parent-tool-call",
      runId: "wf-test-run",
      signal,
    });

    let threw = false;
    try {
      await bridge.agent("test prompt", { label: "test", schema: {} });
    } catch (e) {
      threw = true;
      expect((e as Error).message).toContain("StructuredOutputMismatchError");
    }
    expect(threw).toBe(true);

    setWorkflowForkRunnerForTests(null);
  });

  it("resolves a terminal API/provider failure to null so the script continues", async () => {
    setWorkflowForkRunnerForTests(async () => {
      return {
        output:
          'fork error: HTTP 429 from /v1/messages: {"error":{"type":"rate_limit_error","message":"Rate limited"}}',
        isError: true,
      };
    });

    const signal = new AbortController().signal;
    const bridge = await createWorkflowSubagentBridge({
      ctx: ctx(true),
      parentToolCallId: "parent-tool-call",
      runId: "wf-apierr-run",
      signal,
    });

    // Sequential `await agent()` must NOT throw on a dead agent — the
    // documented contract returns null and later phases still dispatch.
    const first = await bridge.agent("doomed prompt", { label: "p1" });
    expect(first).toBeNull();

    setWorkflowForkRunnerForTests(async () => ({ output: "phase-2 ran", isError: false }));
    const second = await bridge.agent("next phase", { label: "p2" });
    expect(second).toBe("phase-2 ran");

    setWorkflowForkRunnerForTests(null);
  });

  it("still throws on stall abandonment", async () => {
    setWorkflowForkRunnerForTests(async () => {
      return { output: "agent stalled on all attempts", isError: true, stalled: true };
    });

    const signal = new AbortController().signal;
    const bridge = await createWorkflowSubagentBridge({
      ctx: ctx(true),
      parentToolCallId: "parent-tool-call",
      runId: "wf-stall-run",
      signal,
    });

    let threw = false;
    try {
      await bridge.agent("wedged prompt", { label: "stall" });
    } catch (e) {
      threw = true;
      expect((e as Error).message).toContain("stalled");
    }
    expect(threw).toBe(true);

    setWorkflowForkRunnerForTests(null);
  });

  it("treats a manual workflow close as cancellation, not a missing-output error", async () => {
    const controller = new AbortController();
    setWorkflowForkRunnerForTests(async () => {
      // Simulate the user closing the workflow while a schema agent is in-flight:
      // the fork returns aborted, with no structured output.
      controller.abort();
      return { output: "partial", isError: false };
    });

    const bridge = await createWorkflowSubagentBridge({
      ctx: ctx(true),
      parentToolCallId: "parent-tool-call",
      runId: "wf-abort-run",
      signal: controller.signal,
    });

    let message = "";
    try {
      await bridge.agent("test prompt", { label: "test", schema: {} });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("Workflow was aborted");
    expect(message).not.toContain("StructuredOutputMissingError");

    setWorkflowForkRunnerForTests(null);
  });
});

describe("bridge.parallel", () => {
  it("throws immediately on a non-function slot instead of resolving it to null", async () => {
    const signal = new AbortController().signal;
    const bridge = await createWorkflowSubagentBridge({
      ctx: ctx(true),
      parentToolCallId: "parent-tool-call",
      runId: "wf-parallel-typeerror",
      signal,
    });

    let ran = false;
    const thunks = [
      () => {
        ran = true;
        return Promise.resolve("ok");
      },
      Promise.resolve("a promise, not a thunk"),
    ];

    await expect(bridge.parallel(thunks)).rejects.toMatchObject({
      name: "TypeError",
      message: "parallel() expects an array of functions; slot 1 is object.",
    });
    // Validation runs up front — no slot dispatches before the throw.
    expect(ran).toBe(false);
  });

  it("names the offending slot and its typeof for primitives too", async () => {
    const signal = new AbortController().signal;
    const bridge = await createWorkflowSubagentBridge({
      ctx: ctx(true),
      parentToolCallId: "parent-tool-call",
      runId: "wf-parallel-typeerror-2",
      signal,
    });

    await expect(bridge.parallel([() => Promise.resolve(1), "not a function", 42])).rejects.toThrow(
      "parallel() expects an array of functions; slot 1 is string",
    );
  });

  it("still resolves a thrown thunk to null (unaffected by the type-validation change)", async () => {
    const signal = new AbortController().signal;
    const bridge = await createWorkflowSubagentBridge({
      ctx: ctx(true),
      parentToolCallId: "parent-tool-call",
      runId: "wf-parallel-throw",
      signal,
    });

    const results = await bridge.parallel([
      () => Promise.resolve("ok"),
      () => {
        throw new Error("boom");
      },
    ]);
    expect(results).toEqual(["ok", null]);
  });
});

describe("bridge.pipeline", () => {
  it("throws immediately on a non-function stage, before running any item", async () => {
    const signal = new AbortController().signal;
    const bridge = await createWorkflowSubagentBridge({
      ctx: ctx(true),
      parentToolCallId: "parent-tool-call",
      runId: "wf-pipeline-typeerror",
      signal,
    });

    let stage1Ran = false;
    const stage1 = (v: unknown) => {
      stage1Ran = true;
      return v;
    };

    await expect(
      bridge.pipeline(["a", "b"], stage1, null as unknown as (v: unknown) => unknown),
    ).rejects.toMatchObject({
      name: "TypeError",
      message: "pipeline() expects a function for each stage; stage 1 is object.",
    });
    expect(stage1Ran).toBe(false);
  });

  it("short-circuits remaining stages for an item whose stage resolves to null; other items unaffected", async () => {
    const signal = new AbortController().signal;
    const bridge = await createWorkflowSubagentBridge({
      ctx: ctx(true),
      parentToolCallId: "parent-tool-call",
      runId: "wf-pipeline-null-shortcircuit",
      signal,
    });

    const stage2Calls: unknown[] = [];
    const stage1 = (v: string) => (v === "skip" ? null : `${v}-s1`);
    const stage2 = (v: unknown) => {
      stage2Calls.push(v);
      return `${v}-s2`;
    };

    const results = await bridge.pipeline(["keep", "skip"], stage1, stage2);

    expect(results).toEqual(["keep-s1-s2", null]);
    // stage2 only ran for the item that survived stage1 — the "skip" item's
    // remaining stages were skipped entirely, not called with null.
    expect(stage2Calls).toEqual(["keep-s1"]);
  });
});
