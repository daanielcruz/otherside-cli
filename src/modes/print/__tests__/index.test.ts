import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as agentRegistry from "@/engine/agents/registry.ts";
import {
  clear as clearBackgroundTasks,
  completeTask,
  removeTask,
  startShellTask,
  startTask,
} from "@/engine/background/tasks/background.ts";
import {
  enrollWorkflowTask,
  finalizeWorkflowTask,
  resetWorkflowTasksForTests,
} from "@/engine/background/workflows/runtime/store/store.ts";
import type { WorkflowTaskLifecycle } from "@/engine/background/workflows/runtime/store/types.ts";
import type { Provider } from "@/engine/contract/types.ts";
import * as providers from "@/engine/providers/registry.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import type { Agent } from "@/engine/queue/index.ts";
import * as toolRegistry from "@/engine/tools/registry.ts";
import type { ComposedHarness } from "@/harness/composer/injections.ts";
import {
  clientFor,
  closeAllClients,
  setMcpClientSpawnerForTests,
} from "@/kernel/mcp/client/registry.ts";
import type { McpClient, McpToolInfo } from "@/kernel/mcp/protocol/types.ts";
import { permissionDirectoryGlob, serializeRuleValue } from "@/kernel/permissions/types.ts";
import type { AgentEvent } from "@/kernel/std/types/events.ts";
import { runPrintMode } from "@/modes/print/index.ts";
import type { PrintRuntime } from "@/modes/print/types.ts";

type Frame = Record<string, unknown>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// runPrintMode reads parser-mirrored env for local CLI flags; isolate cases.
beforeEach(() => {
  clearBackgroundTasks();
  resetWorkflowTasksForTests();
  emitQueue._resetForTests();
});

afterEach(async () => {
  delete process.env.OTHERSIDE_CLI_SESSION_ID;
  delete process.env.OTHERSIDE_CLI_FORK_SESSION;
  delete process.env.OTHERSIDE_CLI_RESUME_ACTIVE;
  delete process.env.OTHERSIDE_CLI_ADD_DIRS;
  delete process.env.OTHERSIDE_CLI_INCLUDE_PARTIAL_MESSAGES;
  delete process.env.OTHERSIDE_CLI_SYSTEM_PROMPT;
  delete process.env.OTHERSIDE_CLI_APPEND_SYSTEM_PROMPT;
  delete process.env.OTHERSIDE_CLI_MAX_BUDGET_USD;
  delete process.env.OTHERSIDE_CLI_FALLBACK_ROUTE;
  delete process.env.OTHERSIDE_CLI_MCP_CONFIGS;
  delete process.env.OTHERSIDE_CLI_AGENTS_JSON;
  delete process.env.OTHERSIDE_CLI_JSON_SCHEMA;
  delete process.env.MAX_STRUCTURED_OUTPUT_RETRIES;
  agentRegistry.clear();
  clearBackgroundTasks();
  resetWorkflowTasksForTests();
  emitQueue._resetForTests();
  setMcpClientSpawnerForTests(null);
  await closeAllClients();
});

function fakeAgent(events: AgentEvent[]): Agent {
  return {
    runTurn: async function* () {
      for (const ev of events) yield ev;
    },
  } as unknown as Agent;
}

function brokerBackedAgent(turns: AgentEvent[][]): Agent {
  const state = {
    provider: "anthropic",
    model: "test-model",
    effort: null,
    fastMode: false,
    permissionMode: "accept-edits",
  };
  let calls = 0;
  return {
    deps: {
      broker: {
        read: () => state,
        dispatch: (event: { kind: string; route?: { provider: string; model: string } }) => {
          if (event.kind !== "set_route" || event.route === undefined) return;
          state.provider = event.route.provider;
          state.model = event.route.model;
        },
      },
    },
    runTurn: async function* () {
      const events = turns[calls] ?? [];
      calls += 1;
      for (const ev of events) yield ev;
    },
  } as unknown as Agent;
}

function asyncFollowupAgent(startAsyncTask: () => void): {
  agent: Agent;
  notificationBlocks: () => number;
} {
  let calls = 0;
  let notificationBlocks = 0;
  return {
    agent: {
      runTurn: async function* () {
        calls += 1;
        if (calls === 1) {
          startAsyncTask();
          for (const event of HELLO_TURN) yield event;
          return;
        }
        const continuation = emitQueue.drainForBoundary("turn_start");
        notificationBlocks += continuation.llmBlocks.length;
        yield { kind: "turn_start", turn: calls - 1 };
        yield { kind: "text_delta", text: "async complete" };
        yield { kind: "message_stop", stop_reason: "end_turn" };
        yield { kind: "turn_end", turn: calls - 1, stopReason: "end_turn" };
      },
    } as unknown as Agent,
    notificationBlocks: () => notificationBlocks,
  };
}

function providerCaptureAgent(events: AgentEvent[]): Agent {
  return {
    ...brokerBackedAgent([events]),
    runTurn: async function* () {
      providers.get("anthropic").composeMessages(BASE_HARNESS, []);
      for (const ev of events) yield ev;
    },
  } as unknown as Agent;
}

function structuredToolAgent(input: unknown): Agent {
  return {
    runTurn: async function* () {
      const id = "toolu_structured";
      const name = "StructuredOutput";
      yield { kind: "turn_start", turn: 0 };
      yield { kind: "tool_call_complete", id, name, input };
      const result = await toolRegistry.get(name)?.run({ id, name, input }, {} as never);
      yield {
        kind: "tool_dispatch_complete",
        id,
        name,
        content:
          typeof result?.content === "string" ? result.content : JSON.stringify(result?.content),
        isError: result?.is_error === true,
      };
      yield { kind: "message_stop", stop_reason: "tool_calls" };
      yield { kind: "turn_end", turn: 0, stopReason: "tool_calls" };
    },
  } as unknown as Agent;
}

function registerCaptureProvider(captured: ComposedHarness[]): void {
  providers.register({
    id: "anthropic",
    label: "Test Anthropic",
    shortKey: "test",
    featureFlags: () => ({}),
    modelAvailable: () => true,
    defaultModelId: () => "test-model",
    fallbackEfforts: () => ({ levels: [], default: null }),
    allowsCustomModel: () => false,
    fingerprint: () => ({ provider: "anthropic", model: "test-model" }),
    injectHeaders: () => ({}),
    translateRequest: () => ({}),
    translateResponse: async function* () {},
    stream: async function* () {},
    defaultModels: () => [],
    deferredOverrides: () => ({ excludeFromCatalog: [], emitDeferredReminder: false }),
    promptAdapter: () => null,
    recoverableError: () => ({ action: "fail" }),
    usageDetails: () => ({ sourceLabel: "test" }),
    beginLogin: () => ({ kind: "not_supported" }),
    composeForkSystem: () => [],
    composeForkUserBlock: (prompt: string) => ({ type: "text", text: prompt }),
    composeMessages: (harness: ComposedHarness) => {
      captured.push(harness);
      return [];
    },
  } as unknown as Provider);
}

const BASE_HARNESS: ComposedHarness = {
  layers: [{ name: "base", body: "default base" }],
  combined: "default base",
  systemBlocks: [{ text: "default base", phase: "static", bundleKey: "base" }],
  userPrepend: [],
  midSystemPromotion: "off",
};

// Honors cancel() by stopping the event stream — mirrors the real agent, whose
// turn loop returns once host.cancelled is set (how --max-turns takes effect).
function cancellableFakeAgent(events: AgentEvent[]): Agent {
  const state = { cancelled: false };
  return {
    cancel: () => {
      state.cancelled = true;
    },
    runTurn: async function* () {
      for (const ev of events) {
        if (state.cancelled) return;
        yield ev;
      }
    },
  } as unknown as Agent;
}

function sessionFakeAgent(
  events: AgentEvent[],
  sessionId = "sess-1",
): Agent & { deps: { session: { id: string } }; sessionAllowedToolPatterns: Set<string> } {
  return {
    ...fakeAgent(events),
    deps: { session: { id: sessionId } },
    sessionAllowedToolPatterns: new Set<string>(),
  } as unknown as Agent & {
    deps: { session: { id: string } };
    sessionAllowedToolPatterns: Set<string>;
  };
}

function fakeMcpClient(tools: McpToolInfo[] = []): McpClient {
  let closed = false;
  return {
    listTools: async () => tools,
    callTool: async () => ({}),
    listResources: async () => [],
    readResource: async () => ({}),
    listDirectory: async () => ({ resources: [] }),
    serverCapabilities: () => null,
    serverInstructions: () => null,
    listPrompts: async () => [],
    getPrompt: async () => ({ messages: [] }),
    announce: () => {},
    isClosed: () => closed,
    close: () => {
      closed = true;
    },
  };
}

const BASE_RUNTIME: PrintRuntime = {
  sessionId: "sess-1",
  cwd: "/tmp",
  route: { provider: "anthropic", model: "test-model" },
  permissionMode: "accept-edits",
  verbose: false,
  contextWindow: 200_000,
  pricing: null,
  maxTurns: null,
  toolNames: ["Read"],
  slashCommands: [],
  agentNames: [],
  skillNames: [],
  mcpServers: [],
  version: "0.0.0-test",
};

const HELLO_TURN: AgentEvent[] = [
  { kind: "turn_start", turn: 0 },
  { kind: "text_delta", text: "hello" },
  { kind: "usage", inputTokens: 10, outputTokens: 5 },
  { kind: "message_stop", stop_reason: "end_turn" },
  { kind: "turn_end", turn: 0, stopReason: "end_turn" },
];

// Two assistant messages: the result envelope must report only the last turn.
const MULTITURN: AgentEvent[] = [
  { kind: "text_delta", text: "first" },
  { kind: "message_stop", stop_reason: "tool_use" },
  { kind: "text_delta", text: "second" },
  { kind: "message_stop", stop_reason: "end_turn" },
  { kind: "turn_end", turn: 0, stopReason: "end_turn" },
];

const ERROR_TURN: AgentEvent[] = [
  { kind: "text_delta", text: "partial" },
  { kind: "error", error: "boom" },
];

async function captureStdout(fn: () => Promise<number>): Promise<{ out: string; code: number }> {
  const chunks: string[] = [];
  const original = process.stdout.write;
  const mock = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  process.stdout.write = mock as unknown as typeof process.stdout.write;
  try {
    const code = await fn();
    return { out: chunks.join(""), code };
  } finally {
    process.stdout.write = original;
  }
}

describe("runPrintMode json output shape", () => {
  it("prints only the final result object when non-verbose", async () => {
    const { out, code } = await captureStdout(() =>
      runPrintMode(fakeAgent(HELLO_TURN), "hi", "json", { ...BASE_RUNTIME, verbose: false }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect(Array.isArray(parsed)).toBe(false);
    expect(parsed.type).toBe("result");
    expect(parsed.subtype).toBe("success");
    expect(parsed.result).toBe("hello");
  });

  it("prints the full frame array when --verbose", async () => {
    const { out } = await captureStdout(() =>
      runPrintMode(fakeAgent(HELLO_TURN), "hi", "json", { ...BASE_RUNTIME, verbose: true }),
    );
    const parsed = JSON.parse(out.trim()) as Frame[];
    expect(Array.isArray(parsed)).toBe(true);
    const initFrame = parsed.find((f) => f.type === "system" && f.subtype === "init");
    expect(initFrame).toBeDefined();
    const resultFrame = parsed.find((f) => f.type === "result");
    expect(resultFrame?.result).toBe("hello");
  });
});

describe("runPrintMode structured output", () => {
  it("emits a conforming StructuredOutput payload on the result frame", async () => {
    process.env.OTHERSIDE_CLI_JSON_SCHEMA = JSON.stringify({
      type: "object",
      properties: { ok: { type: "boolean" }, answer: { type: "string" } },
      required: ["ok", "answer"],
      additionalProperties: false,
    });
    const payload = { ok: true, answer: "done" };

    const { out, code } = await captureStdout(() =>
      runPrintMode(structuredToolAgent(payload), "hi", "json", BASE_RUNTIME),
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect(parsed.subtype).toBe("success");
    expect(parsed.structured_output).toEqual(payload);
  });

  it("returns error_max_structured_output_retries after non-conforming tool input", async () => {
    process.env.MAX_STRUCTURED_OUTPUT_RETRIES = "1";
    process.env.OTHERSIDE_CLI_JSON_SCHEMA = JSON.stringify({
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    });

    const { out, code } = await captureStdout(() =>
      runPrintMode(structuredToolAgent({ ok: "yes" }), "hi", "json", BASE_RUNTIME),
    );

    expect(code).toBe(1);
    const parsed = JSON.parse(out.trim());
    expect(parsed.subtype).toBe("error_max_structured_output_retries");
    expect(parsed.is_error).toBe(true);
    expect(parsed.structured_output).toBeUndefined();
    expect(parsed.errors[0]).toContain("Reached maximum StructuredOutput retries (1)");
  });
});

describe("runPrintMode result envelope", () => {
  it("reports only the last turn's text as result", async () => {
    const { out } = await captureStdout(() =>
      runPrintMode(fakeAgent(MULTITURN), "hi", "json", BASE_RUNTIME),
    );
    const parsed = JSON.parse(out.trim());
    expect(parsed.result).toBe("second");
  });

  it("uses error_during_execution + errors[] + empty result on failure", async () => {
    const { out, code } = await captureStdout(() =>
      runPrintMode(fakeAgent(ERROR_TURN), "hi", "json", BASE_RUNTIME),
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(out.trim());
    expect(parsed.subtype).toBe("error_during_execution");
    expect(parsed.is_error).toBe(true);
    expect(parsed.result).toBe("");
    expect(parsed.errors).toEqual(["boom"]);
    expect(parsed.error).toBeUndefined();
  });

  it("prunes ours-only usage keys and enriches modelUsage", async () => {
    const { out } = await captureStdout(() =>
      runPrintMode(fakeAgent(HELLO_TURN), "hi", "json", BASE_RUNTIME),
    );
    const parsed = JSON.parse(out.trim());
    expect(parsed.usage.thought_tokens).toBeUndefined();
    expect(parsed.usage.input_tokens_max).toBeUndefined();
    const modelUsage = parsed.modelUsage["test-model"];
    expect(modelUsage.webSearchRequests).toBe(0);
    expect(modelUsage.contextWindow).toBe(200_000);
  });

  it("computes total_cost_usd from usage when pricing is known", async () => {
    const { out } = await captureStdout(() =>
      runPrintMode(fakeAgent(HELLO_TURN), "hi", "json", {
        ...BASE_RUNTIME,
        pricing: { inputPerM: 1_000_000, outputPerM: 2_000_000, currency: "USD" },
      }),
    );
    const parsed = JSON.parse(out.trim());
    // 10 input @ $1M/M + 5 output @ $2M/M = 10 + 10 = 20
    expect(parsed.total_cost_usd).toBe(20);
    expect(parsed.modelUsage["test-model"].costUSD).toBe(20);
  });

  it("reports zero cost when pricing is unknown", async () => {
    const { out } = await captureStdout(() =>
      runPrintMode(fakeAgent(HELLO_TURN), "hi", "json", BASE_RUNTIME),
    );
    const parsed = JSON.parse(out.trim());
    expect(parsed.total_cost_usd).toBe(0);
  });

  it("stops with error_max_budget_usd after a turn exceeds the USD budget", async () => {
    process.env.OTHERSIDE_CLI_MAX_BUDGET_USD = "1";
    const { out, code } = await captureStdout(() =>
      runPrintMode(cancellableFakeAgent(HELLO_TURN), "hi", "json", {
        ...BASE_RUNTIME,
        pricing: { inputPerM: 1_000_000, outputPerM: 2_000_000, currency: "USD" },
      }),
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(out.trim());
    expect(parsed.subtype).toBe("error_max_budget_usd");
    expect(parsed.is_error).toBe(true);
    expect(parsed.errors).toEqual(["Exceeded USD budget (1)"]);
    expect(parsed.total_cost_usd).toBe(20);
  });
});

describe("runPrintMode async completion continuation", () => {
  it("waits for a background Agent and consumes its completion before exit", async () => {
    let taskId = "";
    const harness = asyncFollowupAgent(() => {
      const task = startTask({
        parentToolCallId: "tool-agent",
        agentName: "worker",
        isBackgrounded: true,
      });
      taskId = task.id;
      setTimeout(() => completeTask(task.id, { content: "done", isError: false }), 0);
    });

    const { out, code } = await captureStdout(() =>
      runPrintMode(harness.agent, "hi", "json", BASE_RUNTIME),
    );

    expect(code).toBe(0);
    expect(JSON.parse(out.trim()).result).toBe("async complete");
    expect(harness.notificationBlocks()).toBe(1);
    expect(taskId.length).toBeGreaterThan(0);
  });

  it("waits for a Workflow and consumes its completion before exit", async () => {
    const harness = asyncFollowupAgent(() => {
      const task: WorkflowTaskLifecycle = {
        id: "workflow-task",
        type: "local_workflow",
        status: "running",
        parentToolCallId: "tool-workflow",
        workflowRunId: "wf_print_test",
        cwd: BASE_RUNTIME.cwd,
        sessionId: BASE_RUNTIME.sessionId,
        workflowName: "print-test",
        description: "Print test workflow",
        workflowProgress: [],
        progressVersion: 0,
        agentCount: 0,
        totalTokens: 0,
        totalToolCalls: 0,
        logs: [],
        startedAt: Date.now(),
        abortController: new AbortController(),
      };
      enrollWorkflowTask(task);
      setTimeout(() => finalizeWorkflowTask(task.id, { ok: true }, "/unused/output.json"), 0);
    });

    const { out, code } = await captureStdout(() =>
      runPrintMode(harness.agent, "hi", "json", BASE_RUNTIME),
    );

    expect(code).toBe(0);
    expect(JSON.parse(out.trim()).result).toBe("async complete");
    expect(harness.notificationBlocks()).toBe(1);
  });

  it("does not keep print mode alive for a background shell", async () => {
    let shellId = "";
    const agent = {
      runTurn: async function* () {
        const shell = startShellTask({
          shellId: "shell-print-test",
          command: "sleep 100",
          parentToolCallId: "tool-shell",
        });
        shellId = shell.id;
        for (const event of HELLO_TURN) yield event;
      },
    } as unknown as Agent;

    const { out, code } = await captureStdout(() =>
      runPrintMode(agent, "hi", "json", BASE_RUNTIME),
    );

    expect(code).toBe(0);
    expect(JSON.parse(out.trim()).result).toBe("hello");
    expect(removeTask(shellId)).toBe(true);
  });
});

describe("runPrintMode G7 flag effects", () => {
  it("uses a requested --session-id for frames and the backing session", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    process.env.OTHERSIDE_CLI_SESSION_ID = id;
    const agent = sessionFakeAgent(HELLO_TURN, "sess-1");
    const { out } = await captureStdout(() => runPrintMode(agent, "hi", "json", BASE_RUNTIME));
    const parsed = JSON.parse(out.trim());
    expect(parsed.session_id).toBe(id);
    expect(agent.deps.session.id).toBe(id);
  });

  it("forks resumed print sessions into a new UUID", async () => {
    process.env.OTHERSIDE_CLI_FORK_SESSION = "1";
    process.env.OTHERSIDE_CLI_RESUME_ACTIVE = "1";
    const agent = sessionFakeAgent(HELLO_TURN, "resumed-session");
    const { out } = await captureStdout(() =>
      runPrintMode(agent, "hi", "json", { ...BASE_RUNTIME, sessionId: "resumed-session" }),
    );
    const parsed = JSON.parse(out.trim());
    expect(parsed.session_id).not.toBe("resumed-session");
    expect(parsed.session_id).toMatch(UUID_RE);
    expect(agent.deps.session.id).toBe(parsed.session_id);
  });

  it("ignores --fork-session without a resume", async () => {
    process.env.OTHERSIDE_CLI_FORK_SESSION = "1";
    const agent = sessionFakeAgent(HELLO_TURN, "sess-1");
    const { out } = await captureStdout(() => runPrintMode(agent, "hi", "json", BASE_RUNTIME));
    const parsed = JSON.parse(out.trim());
    expect(parsed.session_id).toBe("sess-1");
    expect(agent.deps.session.id).toBe("sess-1");
  });

  it("adds --add-dir paths to the print session read scope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otherside-print-add-dir-"));
    try {
      process.env.OTHERSIDE_CLI_ADD_DIRS = JSON.stringify([dir]);
      const agent = sessionFakeAgent(HELLO_TURN);
      await captureStdout(() => runPrintMode(agent, "hi", "json", BASE_RUNTIME));
      expect(
        agent.sessionAllowedToolPatterns.has(
          serializeRuleValue({ toolName: "Read", ruleContent: dir }),
        ),
      ).toBe(true);
      expect(
        agent.sessionAllowedToolPatterns.has(
          serializeRuleValue({
            toolName: "Read",
            ruleContent: permissionDirectoryGlob(dir),
          }),
        ),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces the composed system prompt when --system-prompt is set", async () => {
    const captured: ComposedHarness[] = [];
    registerCaptureProvider(captured);
    process.env.OTHERSIDE_CLI_SYSTEM_PROMPT = "replacement prompt";
    await captureStdout(() =>
      runPrintMode(providerCaptureAgent(HELLO_TURN), "hi", "json", BASE_RUNTIME),
    );
    expect(captured[0]?.combined).toBe("replacement prompt");
    expect(captured[0]?.systemBlocks.map((block) => block.text)).toEqual(["replacement prompt"]);
  });

  it("appends to the composed system prompt when --append-system-prompt is set", async () => {
    const captured: ComposedHarness[] = [];
    registerCaptureProvider(captured);
    process.env.OTHERSIDE_CLI_APPEND_SYSTEM_PROMPT = "extra prompt";
    await captureStdout(() =>
      runPrintMode(providerCaptureAgent(HELLO_TURN), "hi", "json", BASE_RUNTIME),
    );
    expect(captured[0]?.combined).toBe("default base\n\nextra prompt");
    expect(captured[0]?.systemBlocks.map((block) => block.text)).toEqual([
      "default base",
      "extra prompt",
    ]);
  });

  it("retries once on the fallback provider-model route for terminal rate-limit errors", async () => {
    const agent = brokerBackedAgent([
      [{ kind: "error", error: "rate limit exceeded" }],
      HELLO_TURN,
    ]);
    const { out, code } = await captureStdout(() =>
      runPrintMode(agent, "hi", "json", {
        ...BASE_RUNTIME,
        fallbackRoute: { provider: "codex", model: "fallback-model" },
      }),
    );
    expect(code).toBe(0);
    expect(agent.deps.broker.read()).toMatchObject({
      provider: "codex",
      model: "fallback-model",
    });
    const parsed = JSON.parse(out.trim());
    expect(parsed.subtype).toBe("success");
    expect(parsed.result).toBe("hello");
  });
});

describe("runPrintMode --max-turns", () => {
  it("stops at the cap and emits error_max_turns (json)", async () => {
    const { out, code } = await captureStdout(() =>
      runPrintMode(cancellableFakeAgent(MULTITURN), "hi", "json", {
        ...BASE_RUNTIME,
        maxTurns: 1,
      }),
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(out.trim());
    expect(parsed.subtype).toBe("error_max_turns");
    expect(parsed.is_error).toBe(true);
    expect(parsed.result).toBe("");
    expect(parsed.num_turns).toBe(1);
    expect(parsed.errors).toEqual(["Reached max turns (1)"]);
  });

  it("prints the fixed max-turns string in text mode", async () => {
    const { out, code } = await captureStdout(() =>
      runPrintMode(cancellableFakeAgent(MULTITURN), "hi", "text", {
        ...BASE_RUNTIME,
        maxTurns: 1,
      }),
    );
    expect(code).toBe(1);
    expect(out).toBe("Error: Reached max turns (1)");
  });

  it("runs unbounded when maxTurns is null", async () => {
    const { out } = await captureStdout(() =>
      runPrintMode(cancellableFakeAgent(MULTITURN), "hi", "json", BASE_RUNTIME),
    );
    const parsed = JSON.parse(out.trim());
    expect(parsed.subtype).toBe("success");
    expect(parsed.num_turns).toBe(2);
  });
});

describe("runPrintMode stream-json gate", () => {
  it("requires --verbose and exits 1 otherwise", async () => {
    const original = process.stderr.write;
    let errText = "";
    const mock = (chunk: unknown): boolean => {
      errText += String(chunk);
      return true;
    };
    process.stderr.write = mock as unknown as typeof process.stderr.write;
    try {
      const code = await runPrintMode(fakeAgent([]), "hi", "stream-json", {
        ...BASE_RUNTIME,
        verbose: false,
      });
      expect(code).toBe(1);
      expect(errText).toContain("requires --verbose");
    } finally {
      process.stderr.write = original;
    }
  });

  it("emits provider events as stream_event frames when partial messages are requested", async () => {
    process.env.OTHERSIDE_CLI_INCLUDE_PARTIAL_MESSAGES = "1";
    const { out } = await captureStdout(() =>
      runPrintMode(fakeAgent(HELLO_TURN), "hi", "stream-json", {
        ...BASE_RUNTIME,
        verbose: true,
      }),
    );
    const frames = out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Frame);
    const partialFrames = frames.filter((frame) => frame.type === "stream_event");
    expect(partialFrames.map((frame) => (frame.event as { kind: string }).kind)).toEqual([
      "text_delta",
      "usage",
      "message_stop",
    ]);
    expect(partialFrames[0]).toMatchObject({
      parent_tool_use_id: null,
      session_id: "sess-1",
    });
    expect(partialFrames[0]?.uuid).toMatch(UUID_RE);
    expect(frames.findIndex((frame) => frame.type === "assistant")).toBeGreaterThan(
      frames.findIndex(
        (frame) => frame.event && (frame.event as { kind: string }).kind === "message_stop",
      ),
    );
  });
});

describe("runPrintMode system/init wire values", () => {
  it("emits the camelCase permissionMode", async () => {
    const { out } = await captureStdout(() =>
      runPrintMode(fakeAgent(HELLO_TURN), "hi", "json", {
        ...BASE_RUNTIME,
        verbose: true,
        permissionMode: "accept-edits",
      }),
    );
    const parsed = JSON.parse(out.trim()) as Frame[];
    const initFrame = parsed.find((f) => f.type === "system" && f.subtype === "init");
    expect(initFrame?.permissionMode).toBe("acceptEdits");
  });

  it("maps the Agent tool to the SDK name Task in the tools list", async () => {
    const { out } = await captureStdout(() =>
      runPrintMode(fakeAgent(HELLO_TURN), "hi", "json", {
        ...BASE_RUNTIME,
        verbose: true,
        toolNames: ["Agent", "Read"],
      }),
    );
    const parsed = JSON.parse(out.trim()) as Frame[];
    const initFrame = parsed.find((f) => f.type === "system" && f.subtype === "init");
    expect(initFrame?.tools).toEqual(["Task", "Read"]);
  });

  it("emits MCP server names with connection status", async () => {
    setMcpClientSpawnerForTests(async (name) => {
      if (name === "broken") throw new Error("offline");
      return fakeMcpClient();
    });
    await clientFor("ok", { type: "stdio", command: "server", args: [] });
    await clientFor("broken", { type: "stdio", command: "server", args: [] }).catch(() => {});

    const { out } = await captureStdout(() =>
      runPrintMode(fakeAgent(HELLO_TURN), "hi", "json", {
        ...BASE_RUNTIME,
        verbose: true,
        mcpServers: ["ok", "broken", "queued"],
      }),
    );
    const parsed = JSON.parse(out.trim()) as Frame[];
    const initFrame = parsed.find((f) => f.type === "system" && f.subtype === "init");
    expect(initFrame?.mcp_servers).toEqual([
      { name: "ok", status: "connected" },
      { name: "broken", status: "failed" },
      { name: "queued", status: "pending" },
    ]);
  });

  it("loads print-only MCP config, registers tools, and closes clients", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otherside-print-mcp-"));
    const clients: McpClient[] = [];
    try {
      const configPath = join(dir, "mcp.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: { fileServer: { type: "stdio", command: "server", args: [] } },
        }),
      );
      process.env.OTHERSIDE_CLI_MCP_CONFIGS = JSON.stringify([
        configPath,
        JSON.stringify({
          mcpServers: { inlineServer: { type: "stdio", command: "server", args: [] } },
        }),
      ]);
      setMcpClientSpawnerForTests(async () => {
        const client = fakeMcpClient([
          { name: "echo", description: "Echo", inputSchema: { type: "object" } },
        ]);
        clients.push(client);
        return client;
      });
      const seenTools: string[][] = [];
      const agent = {
        runTurn: async function* () {
          seenTools.push(toolRegistry.list().map((handler) => handler.schema.name));
          for (const ev of HELLO_TURN) yield ev;
        },
      } as unknown as Agent;

      const { out, code } = await captureStdout(() =>
        runPrintMode(agent, "hi", "json", { ...BASE_RUNTIME, verbose: true, cwd: dir }),
      );

      expect(code).toBe(0);
      expect(seenTools[0]).toContain("mcp__fileServer__echo");
      expect(seenTools[0]).toContain("mcp__inlineServer__echo");
      expect(toolRegistry.get("mcp__fileServer__echo")).toBeUndefined();
      expect(toolRegistry.get("mcp__inlineServer__echo")).toBeUndefined();
      expect(clients.every((client) => client.isClosed())).toBe(true);
      const parsed = JSON.parse(out.trim()) as Frame[];
      const initFrame = parsed.find((f) => f.type === "system" && f.subtype === "init");
      expect(initFrame?.tools).toContain("mcp__fileServer__echo");
      expect(initFrame?.tools).toContain("mcp__inlineServer__echo");
      expect(initFrame?.mcp_servers).toEqual([
        { name: "fileServer", status: "connected" },
        { name: "inlineServer", status: "connected" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runPrintMode print-only agents", () => {
  it("registers inline agents for the session and removes them after", async () => {
    process.env.OTHERSIDE_CLI_AGENTS_JSON = JSON.stringify({
      helper: {
        description: "Helps with tests",
        prompt: "Be concise",
        tools: ["Read"],
        model: "inherit",
      },
    });
    const seen: Array<string | undefined> = [];
    const agent = {
      runTurn: async function* () {
        seen.push(agentRegistry.get("helper")?.body);
        for (const ev of HELLO_TURN) yield ev;
      },
    } as unknown as Agent;

    const { out, code } = await captureStdout(() =>
      runPrintMode(agent, "hi", "json", { ...BASE_RUNTIME, verbose: true }),
    );

    expect(code).toBe(0);
    expect(seen).toEqual(["Be concise"]);
    expect(agentRegistry.get("helper")).toBeUndefined();
    const parsed = JSON.parse(out.trim()) as Frame[];
    const initFrame = parsed.find((f) => f.type === "system" && f.subtype === "init");
    expect(initFrame?.agents).toContain("helper");
  });
});

describe("runPrintMode text mode (final-only)", () => {
  it("prints only the final result, no streamed deltas", async () => {
    const { out } = await captureStdout(() =>
      runPrintMode(fakeAgent(HELLO_TURN), "hi", "text", BASE_RUNTIME),
    );
    expect(out).toBe("hello\n");
  });

  it("prints only the last turn's text on a multi-turn run", async () => {
    const { out } = await captureStdout(() =>
      runPrintMode(fakeAgent(MULTITURN), "hi", "text", BASE_RUNTIME),
    );
    expect(out).toBe("second\n");
  });

  it("prints the fixed error string and exits 1 on failure", async () => {
    const original = process.stderr.write;
    process.stderr.write = (() => true) as unknown as typeof process.stderr.write;
    try {
      const { out, code } = await captureStdout(() =>
        runPrintMode(fakeAgent(ERROR_TURN), "hi", "text", BASE_RUNTIME),
      );
      expect(code).toBe(1);
      expect(out).toBe("Execution error");
    } finally {
      process.stderr.write = original;
    }
  });
});

describe("runPrintMode empty prompt", () => {
  it("returns exit 1 and writes the input-required error", async () => {
    const original = process.stderr.write;
    let errText = "";
    const mock = (chunk: unknown): boolean => {
      errText += String(chunk);
      return true;
    };
    process.stderr.write = mock as unknown as typeof process.stderr.write;
    try {
      const code = await runPrintMode(fakeAgent([]), "   ", "json", BASE_RUNTIME);
      expect(code).toBe(1);
      expect(errText).toContain("must be provided");
    } finally {
      process.stderr.write = original;
    }
  });
});
