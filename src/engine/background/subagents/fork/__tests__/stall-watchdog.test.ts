import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeTask, startTask } from "@/engine/background/tasks/background.ts";
import type { AuthStrategy } from "@/engine/contract/auth.ts";
import type { FallbackEfforts, ProviderFeatureFlags } from "@/engine/contract/feature-flags.ts";
import type { LoginFlow } from "@/engine/contract/login.ts";
import type { ProviderPromptAdapter } from "@/engine/contract/prompt-adapter.ts";
import { registerProviderConfig, unregisterProviderConfig } from "@/engine/contract/registry.ts";
import type { ApiProviderSourceId, ProviderConfig } from "@/engine/contract/types.ts";
import type { WireFingerprint } from "@/engine/contract/wire-fingerprint.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import { loadSubagentTranscript } from "@/engine/session/transcript/subagent-transcript.ts";
import { announceDeferredTool, clearDeferredAnnouncements } from "@/engine/tools/deferred.ts";
import { registerAllBuiltins } from "@/engine/tools/register-builtins.ts";
import * as toolRegistry from "@/engine/tools/registry.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { runForkLoopInContext } from "../loop-runner.ts";
import type { ForkSpec } from "../types.ts";

let tempDir: string;
let originalEphemeralSessionsDir: string | undefined;

beforeAll(() => {
  registerAllBuiltins();
});

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "otherside-watchdog-test-"));
  originalEphemeralSessionsDir = process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
  process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = tempDir;
});

afterEach(async () => {
  if (originalEphemeralSessionsDir === undefined) {
    delete process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR;
  } else {
    process.env.OTHERSIDE_EPHEMERAL_SESSIONS_DIR = originalEphemeralSessionsDir;
  }
  await rm(tempDir, { recursive: true, force: true });
});

function createMockProviderConfig(
  id: string,
  opts: {
    contentIdleTimeoutMs?: number;
    streamDelay?: number;
    streamEvents?: ProviderEvent[][];
    translateRequest?: (messages: Message[]) => unknown;
  },
) {
  let callCount = 0;
  const mockConfig: ProviderConfig<"openai-completions"> = {
    provider: {
      id: id as ProviderId,
      api: "openai-completions",
      sourceId: "builtin" as ApiProviderSourceId,
      label: "Mock Provider",
      shortKey: "mock",
    },
    fingerprint: () => {
      return { name: "test", version: "1" } as unknown as WireFingerprint;
    },
    translateRequest: (_ctx, messages) => opts.translateRequest?.(messages) ?? {},
    translateResponse: (raw: AsyncIterable<Uint8Array>) => {
      const attempt = callCount++;
      return (async function* () {
        if (opts.streamDelay) {
          await new Promise((resolve) => setTimeout(resolve, opts.streamDelay));
        }
        const events = opts.streamEvents?.[attempt] ?? opts.streamEvents?.[0] ?? [];
        for (const ev of events) {
          yield ev;
        }
      })();
    },
    stream: (ctx: RequestContext, body: unknown) => {
      return (async function* () {
        yield new Uint8Array();
      })();
    },
    featureFlags: {} as unknown as ProviderFeatureFlags,
    defaultModelId: "mock-model",
    fallbackEfforts: { levels: [], default: "low" } as unknown as FallbackEfforts,
    deferredOverrides: {
      excludeFromCatalog: [],
      alwaysDeclare: [],
      emitDeferredReminder: false,
    },
    promptAdapter: {} as unknown as ProviderPromptAdapter,
    recoverableError: () => ({ kind: "fail", reason: "test" }),
    usageDetails: { sourceLabel: "mock" },
    beginLogin: {} as unknown as LoginFlow,
    composeMessages: (_harness: unknown, history: Message[]) => history,
    auth: { strategy: "none" } as unknown as AuthStrategy,
    ...(opts.contentIdleTimeoutMs !== undefined
      ? { contentIdleTimeoutMs: opts.contentIdleTimeoutMs }
      : {}),
  };
  registerProviderConfig(mockConfig);
}

describe("fork stall watchdog tests", () => {
  it("clears stall timer when stream consumption ends, so slow tool dispatch does not trigger stall retry", async () => {
    const providerId = "watchdog-slow-tool-provider";
    const toolName = "slow_test_tool";

    // Tool that takes 100ms to execute
    toolRegistry.register({
      schema: {
        name: toolName,
        description: "A slow test tool",
        inputSchema: { type: "object", properties: {} },
      },
      async run(call, ctx) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { tool_use_id: call.id, content: "success" };
      },
    });

    createMockProviderConfig(providerId, {
      streamEvents: [
        // Turn 0: yields a tool call
        [
          { kind: "message_start" },
          { kind: "tool_call_complete", id: "call-1", name: toolName, input: {} },
          { kind: "message_stop", stop_reason: "tool_calls" },
        ],
        // Turn 1: finishes successfully
        [
          { kind: "message_start" },
          {
            kind: "text_delta",
            text: "The subagent kept working across multiple turns and will report full findings once every step of the assigned task has been completed successfully.",
          },
          { kind: "message_stop", stop_reason: "stop" },
        ],
      ],
    });

    try {
      const spec: ForkSpec = {
        name: "test-slow-tool-fork",
        body: "Test slow tool",
        allowSet: new Set([toolName]),
        prompt: "Run the slow tool",
        stallMs: 50, // Small stall timer (50ms)
        ctx: {
          provider: providerId as ProviderId,
          model: "mock-model",
          cwd: tempDir,
          sessionId: "test-session-slow-tool",
          permissionMode: "default",
          effort: null,
        },
      };

      const result = await runForkLoopInContext(spec, "fork-slow-tool", spec.ctx);
      expect(result.isError).toBe(false);
      expect(result.stalled).toBeUndefined();

      const transcript = await loadSubagentTranscript({
        cwd: tempDir,
        sessionId: spec.ctx.sessionId,
        forkId: "fork-slow-tool",
      });

      // Verify that there are no "stream stalled" messages in the transcript
      const stalledMessages = transcript.filter(
        (r) => r.type === "assistant_message" && r.content.includes("stream stalled"),
      );
      expect(stalledMessages.length).toBe(0);
    } finally {
      toolRegistry.unregister(toolName);
      unregisterProviderConfig(providerId as ProviderId);
    }
  });

  it("re-arms the stall timer before the next stream attempt, and fires if it stalls again", async () => {
    const providerId = "watchdog-retry-stall-provider";

    // Set up a mock provider that has a 100ms stream delay
    // This will trigger a stall timeout of 50ms on every attempt
    createMockProviderConfig(providerId, {
      streamDelay: 100,
      streamEvents: [
        [
          { kind: "message_start" },
          { kind: "text_delta", text: "Should stall" },
          { kind: "message_stop", stop_reason: "stop" },
        ],
      ],
    });

    try {
      const spec: ForkSpec = {
        name: "test-retry-stall-fork",
        body: "Test retry stall",
        allowSet: new Set(),
        prompt: "Stall me",
        stallMs: 50, // Small stall timer (50ms)
        ctx: {
          provider: providerId as ProviderId,
          model: "mock-model",
          cwd: tempDir,
          sessionId: "test-session-retry-stall",
          permissionMode: "default",
          effort: null,
        },
      };

      const result = await runForkLoopInContext(spec, "fork-retry-stall", spec.ctx);
      expect(result.isError).toBe(true);
      expect(result.stalled).toBe(true);

      const transcript = await loadSubagentTranscript({
        cwd: tempDir,
        sessionId: spec.ctx.sessionId,
        forkId: "fork-retry-stall",
      });

      // Verify that "stream stalled — no events for 50ms" is present
      const stalledMessages = transcript.filter(
        (r) =>
          r.type === "assistant_message" &&
          r.content.includes("stream stalled — no events for 50ms"),
      );
      // We expect 2 retries, meaning we see the retry message twice (attempt 1 and 2)
      expect(stalledMessages.length).toBe(2);

      // And we expect 1 final stall message when retries are exhausted
      const finalStallMessages = transcript.filter(
        (r) =>
          r.type === "assistant_message" && r.content.includes("stalled — no progress for 50ms"),
      );
      expect(finalStallMessages.length).toBe(1);
    } finally {
      unregisterProviderConfig(providerId as ProviderId);
    }
  });

  it("resolves the stall timer using the provider config contentIdleTimeoutMs if spec.stallMs is not set", async () => {
    const providerId = "watchdog-provider-config-timeout-provider";

    // Set up provider config with contentIdleTimeoutMs = 80ms
    // The stream has a delay of 120ms. Since 120ms > 80ms, it will stall.
    // If it fell back to the 180s default, it would NOT stall.
    createMockProviderConfig(providerId, {
      contentIdleTimeoutMs: 80,
      streamDelay: 120,
      streamEvents: [
        [
          { kind: "message_start" },
          { kind: "text_delta", text: "Resolved timeout stall" },
          { kind: "message_stop", stop_reason: "stop" },
        ],
      ],
    });

    try {
      const spec: ForkSpec = {
        name: "test-provider-timeout-fork",
        body: "Test provider timeout resolution",
        allowSet: new Set(),
        prompt: "Stall on provider timeout",
        // spec.stallMs is left undefined!
        ctx: {
          provider: providerId as ProviderId,
          model: "mock-model",
          cwd: tempDir,
          sessionId: "test-session-provider-timeout",
          permissionMode: "default",
          effort: null,
        },
      };

      const result = await runForkLoopInContext(spec, "fork-provider-timeout", spec.ctx);
      expect(result.isError).toBe(true);
      expect(result.stalled).toBe(true);

      const transcript = await loadSubagentTranscript({
        cwd: tempDir,
        sessionId: spec.ctx.sessionId,
        forkId: "fork-provider-timeout",
      });

      // Verify that it stalled using the resolved 80ms timeout
      const stalledMessages = transcript.filter(
        (r) =>
          r.type === "assistant_message" &&
          r.content.includes("stream stalled — no events for 80ms"),
      );
      expect(stalledMessages.length).toBe(2);
    } finally {
      unregisterProviderConfig(providerId as ProviderId);
    }
  });
});

describe("fork task reminders", () => {
  it("injects a task reminder after ten substantive subagent rounds", async () => {
    const providerId = "fork-task-reminder-provider";
    const toolName = "task_reminder_round_tool";
    const forkId = "fork-task-reminder";
    const requestHadReminder: boolean[] = [];

    toolRegistry.register({
      schema: {
        name: toolName,
        description: "Advance one reminder test round",
        inputSchema: {
          type: "object",
          properties: { index: { type: "number" } },
        },
      },
      async run(call) {
        return { tool_use_id: call.id, content: "continue" };
      },
    });
    // The declaration set is per-agent: announce in the fork's own scope, as
    // its own ToolSearch load would.
    announceDeferredTool("TaskUpdate", forkId);

    const streamEvents: ProviderEvent[][] = Array.from({ length: 10 }, (_, index) => [
      { kind: "message_start" },
      {
        kind: "tool_call_complete",
        id: `round-${index}`,
        name: toolName,
        input: { index },
      },
      { kind: "message_stop", stop_reason: "tool_calls" },
    ]);
    streamEvents.push([
      { kind: "message_start" },
      {
        kind: "text_delta",
        text: "The subagent completed all reminder rounds and is returning a sufficiently detailed final report.",
      },
      { kind: "message_stop", stop_reason: "stop" },
    ]);
    createMockProviderConfig(providerId, {
      streamEvents,
      translateRequest: (messages) => {
        requestHadReminder.push(
          messages.some((message) =>
            message.content.some(
              (block) =>
                block.type === "text" &&
                "reminder_type" in block &&
                block.reminder_type === "task_reminder",
            ),
          ),
        );
        return {};
      },
    });

    try {
      const ctx: RequestContext = {
        provider: providerId as ProviderId,
        model: "mock-model",
        cwd: tempDir,
        sessionId: "test-session-task-reminder",
        permissionMode: "default",
        effort: null,
        agentOwnerId: forkId,
      };
      const spec: ForkSpec = {
        name: "task-reminder-fork",
        body: "Test task reminder injection",
        allowSet: new Set([toolName, "TaskUpdate"]),
        prompt: "Run ten rounds",
        maxTurns: 11,
        extraDeclarations: [
          {
            name: toolName,
            description: "Advance one reminder test round",
            input_schema: {
              type: "object",
              properties: { index: { type: "number" } },
            },
          },
        ],
        ctx,
      };

      const result = await runForkLoopInContext(spec, forkId, ctx);
      expect(result.isError).toBe(false);
      expect(requestHadReminder).toHaveLength(11);
      expect(requestHadReminder.slice(0, 10)).toEqual(Array(10).fill(false));
      expect(requestHadReminder[10]).toBe(true);
    } finally {
      clearDeferredAnnouncements();
      toolRegistry.unregister(toolName);
      unregisterProviderConfig(providerId as ProviderId);
    }
  });
});

describe("fork maxTurns owned-completion grace", () => {
  it("grants one grace turn to drain a pending owned completion at the maxTurns boundary", async () => {
    const providerId = "maxturns-grace-provider";
    const forkId = "fork-maxturns-grace";

    // runForkLoopInContext does not register the notification owner (its caller,
    // runForkLoop, does) — do it here so the owned completion routes to inventory
    // rather than straight to main.
    const releaseOwner = emitQueue.registerOwner(forkId);
    // A running owned background task makes turn 0 park on the keepalive wait
    // instead of settling.
    const bgTask = startTask({
      parentToolCallId: "p-bg",
      agentName: "bg-worker",
      ownerId: forkId,
      isBackgrounded: true,
    });

    createMockProviderConfig(providerId, {
      streamEvents: [
        // Turn 0 (the only turn maxTurns=1 normally allows): a full answer, no
        // tools → the loop parks on owned work at the bottom.
        [
          { kind: "message_start" },
          {
            kind: "text_delta",
            text: "First pass complete; still waiting on the background work to finish before the final report.",
          },
          { kind: "message_stop", stop_reason: "stop" },
        ],
        // Grace turn: the fork answers over the drained completion.
        [
          { kind: "message_start" },
          {
            kind: "text_delta",
            text: "Final summary over the bg result: the background work finished and its output is folded into this complete, self-contained report for the caller.",
          },
          { kind: "message_stop", stop_reason: "stop" },
        ],
      ],
    });

    try {
      const spec: ForkSpec = {
        name: "test-maxturns-grace",
        body: "Test grace turn",
        allowSet: new Set(),
        prompt: "Do the work",
        maxTurns: 1,
        ctx: {
          provider: providerId as ProviderId,
          model: "mock-model",
          cwd: tempDir,
          sessionId: "test-session-maxturns-grace",
          permissionMode: "default",
          effort: null,
        },
      };

      // Complete the owned task once the fork has parked on waitForOwner: its
      // completion notification lands in this owner's inventory and is therefore
      // pending at the next turn's maxTurns boundary.
      const timer = setTimeout(() => {
        completeTask(bgTask.id, { content: "bg result payload", isError: false });
      }, 25);

      const result = await runForkLoopInContext(spec, forkId, spec.ctx);
      clearTimeout(timer);

      // Without the grace turn the fork would break at the boundary and strand
      // the completion (rerouted to main); with it, the fork answers over the
      // drained completion in a single extra turn.
      expect(result.output).toContain("Final summary over the bg result");
      const pending = emitQueue
        .peek({ ownerId: forkId })
        .filter((item) => item.payload.kind === "task_notification_xml");
      expect(pending.length).toBe(0);
    } finally {
      releaseOwner();
      unregisterProviderConfig(providerId as ProviderId);
    }
  });
});
