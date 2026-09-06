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
import { announceDeferredTool, clearDeferredAnnouncements } from "@/engine/tools/deferred.ts";
import { registerAllBuiltins } from "@/engine/tools/register-builtins.ts";
import * as toolRegistry from "@/engine/tools/registry.ts";
import { classifyProviderError } from "@/engine/transport/_infra/classify/classify.ts";
import { StreamSilenceError } from "@/kernel/std/stream/idle-timeout.ts";
import type { ForkEvent, ProviderEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";
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
    streamEmitsKeepalive?: boolean;
    contentIdleTimeoutMs?: number;
    streamErrors?: Array<unknown | undefined>;
    streamEvents?: ProviderEvent[][];
    stream?: NonNullable<ProviderConfig<"openai-completions">["stream"]>;
    translateResponse?: NonNullable<ProviderConfig<"openai-completions">["translateResponse"]>;
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
    translateResponse:
      opts.translateResponse ??
      (() => {
        const attempt = callCount++;
        return (async function* () {
          const error = opts.streamErrors?.[attempt];
          if (error !== undefined) throw error;
          const events = opts.streamEvents?.[attempt] ?? opts.streamEvents?.[0] ?? [];
          for (const ev of events) yield ev;
        })();
      }),
    stream:
      opts.stream ??
      (() =>
        (async function* () {
          yield new Uint8Array();
        })()),
    featureFlags: {} as unknown as ProviderFeatureFlags,
    defaultModelId: "mock-model",
    fallbackEfforts: {
      levels: [],
      default: "low",
    } as unknown as FallbackEfforts,
    deferredOverrides: {
      excludeFromCatalog: [],
      alwaysDeclare: [],
      emitDeferredReminder: false,
    },
    promptAdapter: {} as unknown as ProviderPromptAdapter,
    recoverableError: (error, ctx, attempt) => {
      const decision = classifyProviderError(error, {
        ...(attempt !== undefined ? { attempt } : {}),
        provider: ctx.provider,
        model: ctx.model,
      });
      return decision.kind === "retry" ? { ...decision, delayMs: 0 } : decision;
    },
    usageDetails: { sourceLabel: "mock" },
    beginLogin: {} as unknown as LoginFlow,
    composeMessages: (_harness: unknown, history: Message[]) => history,
    auth: { strategy: "none" } as unknown as AuthStrategy,
    ...(opts.streamEmitsKeepalive === true ? { streamEmitsKeepalive: true } : {}),
    ...(opts.contentIdleTimeoutMs === undefined
      ? {}
      : { contentIdleTimeoutMs: opts.contentIdleTimeoutMs }),
  };
  registerProviderConfig(mockConfig);
  return { getCallCount: () => callCount };
}

describe("fork shared stream watchdog integration", () => {
  it("aborts one ping-fed stream after terminal content idle", async () => {
    const providerId = "watchdog-content-idle-provider";
    const callerAbort = new AbortController();
    let streamCalls = 0;
    let bytesEmitted = 0;
    let sourceClosed = false;
    let attemptSignal: AbortSignal | undefined;
    let abortReason: unknown;
    createMockProviderConfig(providerId, {
      streamEmitsKeepalive: true,
      contentIdleTimeoutMs: 25,
      stream: (_ctx, _body, signal) => {
        streamCalls += 1;
        attemptSignal = signal;
        signal.addEventListener("abort", () => (abortReason = signal.reason), {
          once: true,
        });
        return (async function* () {
          try {
            while (!signal.aborted) {
              bytesEmitted += 1;
              yield new Uint8Array([1]);
              await Bun.sleep(1);
            }
          } finally {
            sourceClosed = true;
          }
        })();
      },
      translateResponse: (raw) => ({
        [Symbol.asyncIterator]() {
          const bytes = raw[Symbol.asyncIterator]();
          return {
            async next(): Promise<IteratorResult<ProviderEvent>> {
              while (true) {
                const result = await bytes.next();
                if (result.done) return { done: true, value: undefined };
              }
            },
          };
        },
      }),
    });

    const spec: ForkSpec = {
      name: "test-content-idle-fork",
      body: "Test content-idle handling",
      allowSet: new Set(),
      prompt: "Encounter a content-idle timeout",
      ctx: {
        provider: providerId as ProviderId,
        model: "mock-model",
        cwd: tempDir,
        sessionId: "test-session-content-idle",
        permissionMode: "default",
        effort: null,
        abortSignal: callerAbort.signal,
      },
    };
    const originalSignal = spec.ctx.abortSignal;

    try {
      const result = await runForkLoopInContext(spec, "fork-content-idle", spec.ctx);
      expect(result).toEqual({
        output:
          "fork error: content stream idle 25ms — aborting (live connection, no model output)",
        isError: true,
      });
      expect(streamCalls).toBe(1);
      expect(spec.ctx.abortSignal).toBe(originalSignal);
      expect(callerAbort.signal.aborted).toBe(false);
      expect(attemptSignal?.aborted).toBe(true);
      expect(abortReason).toBeInstanceOf(StreamSilenceError);
      expect((abortReason as StreamSilenceError).scope).toBe("content");
      await Bun.sleep(20);
      expect(sourceClosed).toBe(true);
      const bytesAfterClose = bytesEmitted;
      await Bun.sleep(20);
      expect(bytesEmitted).toBe(bytesAfterClose);
    } finally {
      unregisterProviderConfig(providerId as ProviderId);
    }
  });

  it("keeps transport failures on the shared retry path", async () => {
    const providerId = "watchdog-transport-retry-provider";
    const emitted: ForkEvent[] = [];
    const provider = createMockProviderConfig(providerId, {
      streamErrors: [
        new Error(
          "The socket connection was closed unexpectedly. For more information, pass verbose: true in the second argument to fetch()",
        ),
      ],
      streamEvents: [
        [],
        [
          { kind: "message_start" },
          {
            kind: "text_delta",
            text: "The transport retry recovered successfully and the subagent completed with a sufficiently detailed final report for its caller.",
          },
          { kind: "message_stop", stop_reason: "stop" },
        ],
      ],
    });

    try {
      const spec: ForkSpec = {
        name: "test-transport-retry-fork",
        body: "Test transport retry handling",
        allowSet: new Set(),
        prompt: "Recover from a transport failure",
        sink: (event) => emitted.push(event),
        ctx: {
          provider: providerId as ProviderId,
          model: "mock-model",
          cwd: tempDir,
          sessionId: "test-session-transport-retry",
          permissionMode: "default",
          effort: null,
        },
      };

      const result = await runForkLoopInContext(spec, "fork-transport-retry", spec.ctx);
      expect(result.isError).toBe(false);
      expect(result.output).toContain("The transport retry recovered successfully");
      expect(provider.getCallCount()).toBe(2);
      expect(emitted.filter((event) => event.kind === "fork_retry_status")).toHaveLength(1);
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
        completeTask(bgTask.id, {
          content: "bg result payload",
          isError: false,
        });
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
