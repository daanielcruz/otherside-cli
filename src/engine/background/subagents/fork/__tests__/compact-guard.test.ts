import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runForkLoopExternal } from "@/engine/background/subagents/dispatcher.ts";
import type { Provider } from "@/engine/contract/types.ts";
import { registerRuntimeModel, resetRuntimeModelsForTests } from "@/engine/model/catalog.ts";
import * as providers from "@/engine/providers/registry.ts";
import { AUTOCOMPACT_RAPID_REFILL_ERROR_MESSAGE } from "@/engine/session/compact/index.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import type { DrainedQueuedMessage, ProviderEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { isForkOverBlockingLimit, maybeCompactFork, maybeMicroCompactFork } from "../compact.ts";
import { FORK_PROMPT_TOO_LONG_MESSAGE } from "../constants.ts";

// A response long enough to skip both the "too short to return" reprompt and
// (for turn 0) the blocking-limit guard when it isn't the thing under test.
const LONG_TURN_TEXT =
  "The subagent kept working across multiple turns and will report full findings once every step of the assigned task has been completed successfully.";

interface Capture {
  isCompaction: boolean;
  messageCount: number;
}

function makeCtx(providerId: ProviderId, model: string, cwd: string): RequestContext {
  return {
    provider: providerId,
    model,
    effort: null,
    permissionMode: "default",
    sessionId: `fork-compact-guard-${crypto.randomUUID()}`,
    cwd,
  };
}

// Every provider call (a real turn request or a compaction summarization
// request) goes through the same translateRequest/stream/translateResponse
// trio, in strict call order, so a single scripted queue drives both.
function registerScriptedProvider(
  providerId: ProviderId,
  eventsByCall: ProviderEvent[][],
  captures: Capture[],
): void {
  let callIndex = 0;
  const provider = {
    id: providerId,
    deferredOverrides: () => ({
      excludeFromCatalog: [],
      alwaysDeclare: [],
      emitDeferredReminder: false,
    }),
    composeMessages: (_harness: unknown, history: Message[]) => history,
    translateRequest: (_ctx: RequestContext, messages: Message[], _tools: unknown[]) => {
      // Compaction is detected by the folded compact directive text, not by
      // disableThinking (the summary request now keeps the conversation envelope).
      const isCompaction = messages.some((m) =>
        m.content.some(
          (b) =>
            b.type === "text" &&
            (b.text.includes("create a detailed summary of the conversation so far") ||
              b.text.includes("REMINDER: Do NOT call any tools")),
        ),
      );
      captures.push({ isCompaction, messageCount: messages.length });
      return {};
    },
    stream: async function* () {},
    translateResponse: async function* () {
      const events = eventsByCall[callIndex] ?? [];
      callIndex += 1;
      for (const event of events) yield event;
    },
    recoverableError: () => ({ kind: "fail", reason: "test" }),
  } as unknown as Provider;
  providers.register(provider);
}

// Summarization events with no text_delta leave the summary text empty, which
// summary.ts turns into a non-retryable EmptyCompactSummaryError -- exactly
// one provider call per failed attempt, no internal peel-and-retry loop.
const FAILED_COMPACT_CALL: ProviderEvent[] = [{ kind: "message_stop", stop_reason: "stop" }];

function successfulCompactCall(summary: string): ProviderEvent[] {
  return [
    { kind: "text_delta", text: summary },
    { kind: "message_stop", stop_reason: "stop" },
  ];
}

function successfulTurnCall(text: string): ProviderEvent[] {
  return [
    { kind: "text_delta", text },
    { kind: "message_stop", stop_reason: "stop" },
  ];
}

function alwaysContinueDrainer(): () => DrainedQueuedMessage[] {
  return () => [{ text: "continue", blocks: [{ type: "text", text: "continue" }] }];
}

describe("fork compaction breaker and blocking-limit guard", () => {
  afterEach(() => {
    resetRuntimeModelsForTests();
  });

  it("re-arms the compact-failure circuit after enough turns pass without a rapid refill", async () => {
    const providerId = `fork-circuit-rearm-${crypto.randomUUID()}` as ProviderId;
    const model = "fork-circuit-rearm-model";
    // The effective-window threshold is crossed after each main turn while the
    // blocking limit stays far enough away to isolate circuit-breaker behavior.
    registerRuntimeModel({
      id: model,
      displayName: model,
      contextWindow: 33_100,
      provider: providerId,
      efforts: [],
      defaultEffort: null,
    });
    const cwd = mkdtempSync(join(tmpdir(), "fork-circuit-rearm-"));
    const captures: Capture[] = [];
    registerScriptedProvider(
      providerId,
      [
        successfulTurnCall(LONG_TURN_TEXT), // turn 0 main
        FAILED_COMPACT_CALL, // turn 1 compact attempt 1
        FAILED_COMPACT_CALL, // turn 1 compact attempt 2 (outer retry)
        successfulTurnCall(LONG_TURN_TEXT), // turn 1 main
        FAILED_COMPACT_CALL, // turn 2 compact attempt 1
        FAILED_COMPACT_CALL, // turn 2 compact attempt 2
        successfulTurnCall(LONG_TURN_TEXT), // turn 2 main
        FAILED_COMPACT_CALL, // turn 3 compact attempt 1 -- 3rd failure, circuit opens
        FAILED_COMPACT_CALL, // turn 3 compact attempt 2
        successfulTurnCall(LONG_TURN_TEXT), // turn 3 main
        successfulCompactCall("Summary text for the re-armed compaction attempt."), // turn 4, re-armed
        successfulTurnCall(LONG_TURN_TEXT), // turn 4 main
      ],
      captures,
    );

    const result = await runForkLoopExternal({
      ctx: makeCtx(providerId, model, cwd),
      name: "Circuit Rearm Test",
      body: "Work across several turns.",
      allowSet: null,
      prompt: "Start the task.",
      agentId: "fork-circuit-rearm-agent",
      maxTurns: 5,
      pendingUserInputDrainer: alwaysContinueDrainer(),
    });

    expect(result.isError).toBe(false);
    const compactionCalls = captures.filter((c) => c.isCompaction);
    const mainCalls = captures.filter((c) => !c.isCompaction);
    // 3 failed attempts (2 calls each) + 1 re-armed successful attempt (1
    // call). A permanently-open circuit would stop at 6 (no 4th attempt).
    expect(compactionCalls.length).toBe(7);
    expect(mainCalls.length).toBe(5);
    // The turn-4 send used the freshly compacted (tiny) transcript.
    expect(mainCalls[4]?.messageCount).toBe(2);
  }, 15_000);

  it("trips the rapid-refill breaker terminally after 3 consecutive rapid refills", async () => {
    const providerId = `fork-rapid-refill-${crypto.randomUUID()}` as ProviderId;
    const model = "fork-rapid-refill-model";
    registerRuntimeModel({
      id: model,
      displayName: model,
      contextWindow: 33_100,
      provider: providerId,
      efforts: [],
      defaultEffort: null,
    });
    const cwd = mkdtempSync(join(tmpdir(), "fork-rapid-refill-"));
    const captures: Capture[] = [];
    registerScriptedProvider(
      providerId,
      [
        successfulTurnCall(LONG_TURN_TEXT), // turn 0 main
        successfulCompactCall("summary 1"), // turn 1 compact (1st success)
        successfulTurnCall(LONG_TURN_TEXT), // turn 1 main
        successfulCompactCall("summary 2"), // turn 2 compact (rapid refill #1)
        successfulTurnCall(LONG_TURN_TEXT), // turn 2 main
        successfulCompactCall("summary 3"), // turn 3 compact (rapid refill #2)
        successfulTurnCall(LONG_TURN_TEXT), // turn 3 main
        successfulCompactCall("summary 4"), // turn 4 compact (rapid refill #3 -> trips)
        successfulTurnCall(LONG_TURN_TEXT), // turn 4 main
      ],
      captures,
    );

    const result = await runForkLoopExternal({
      ctx: makeCtx(providerId, model, cwd),
      name: "Rapid Refill Test",
      body: "Work across several turns.",
      allowSet: null,
      prompt: "Start the task.",
      agentId: "fork-rapid-refill-agent",
      maxTurns: 10,
      pendingUserInputDrainer: alwaysContinueDrainer(),
    });

    expect(result.isError).toBe(true);
    expect(result.output).toBe(AUTOCOMPACT_RAPID_REFILL_ERROR_MESSAGE);
    const mainCalls = captures.filter((c) => !c.isCompaction);
    // Terminated at the start of turn 5, before a 6th main request was sent.
    expect(mainCalls.length).toBe(5);
  });

  it("attempts compaction on turn 0 when the inherited transcript is already over the blocking limit", async () => {
    const providerId = `fork-turn0-blocking-${crypto.randomUUID()}` as ProviderId;
    const model = "fork-turn0-blocking-model";
    // contextWindow 23_500 -> effective window 3_500 (20_000 output reserve) ->
    // blocking limit 500 tokens (3_500 - 3_000 manual-compact buffer).
    registerRuntimeModel({
      id: model,
      displayName: model,
      contextWindow: 23_500,
      provider: providerId,
      efforts: [],
      defaultEffort: null,
    });
    const cwd = mkdtempSync(join(tmpdir(), "fork-turn0-blocking-"));
    const captures: Capture[] = [];
    registerScriptedProvider(
      providerId,
      [
        successfulCompactCall("Compacted summary of the oversized initial prompt."),
        successfulTurnCall(LONG_TURN_TEXT),
      ],
      captures,
    );

    const oversizedPrompt = "x".repeat(2_400); // ~600 estimated tokens, over the 500 limit
    const result = await runForkLoopExternal({
      ctx: makeCtx(providerId, model, cwd),
      name: "Turn 0 Blocking Test",
      body: "Handle the oversized inherited transcript.",
      allowSet: null,
      prompt: "Start the task.",
      agentId: "fork-turn0-blocking-agent",
      initialMessages: [
        { role: "system", content: [{ type: "text", text: "sys" }] },
        { role: "user", content: [{ type: "text", text: oversizedPrompt }] },
      ],
    });

    expect(result.isError).toBe(false);
    expect(result.output).toBe(LONG_TURN_TEXT);
    const compactionCalls = captures.filter((c) => c.isCompaction);
    const mainCalls = captures.filter((c) => !c.isCompaction);
    expect(compactionCalls.length).toBe(1);
    expect(mainCalls.length).toBe(1);
    // The turn-0 send used the compacted (tiny) transcript, not the oversized one.
    expect(mainCalls[0]?.messageCount).toBe(2);
  });

  it("finishes with a terminal 'Prompt is too long' error instead of sending when still over the blocking limit after a failed compaction", async () => {
    const providerId = `fork-turn0-ptl-${crypto.randomUUID()}` as ProviderId;
    const model = "fork-turn0-ptl-model";
    registerRuntimeModel({
      id: model,
      displayName: model,
      contextWindow: 23_500,
      provider: providerId,
      efforts: [],
      defaultEffort: null,
    });
    const cwd = mkdtempSync(join(tmpdir(), "fork-turn0-ptl-"));
    const captures: Capture[] = [];
    registerScriptedProvider(
      providerId,
      [
        FAILED_COMPACT_CALL, // compact attempt 1
        FAILED_COMPACT_CALL, // compact attempt 2 (outer retry)
      ],
      captures,
    );

    const oversizedPrompt = "x".repeat(2_400);
    const result = await runForkLoopExternal({
      ctx: makeCtx(providerId, model, cwd),
      name: "Turn 0 Prompt Too Long Test",
      body: "Handle the oversized inherited transcript.",
      allowSet: null,
      prompt: "Start the task.",
      agentId: "fork-turn0-ptl-agent",
      initialMessages: [
        { role: "system", content: [{ type: "text", text: "sys" }] },
        { role: "user", content: [{ type: "text", text: oversizedPrompt }] },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.output).toBe(FORK_PROMPT_TOO_LONG_MESSAGE);
    // Only the 2 failed compaction calls happened -- no request was ever sent.
    expect(captures.length).toBe(2);
    expect(captures.every((c) => c.isCompaction)).toBe(true);
  }, 10_000);

  describe("env override blocking/micro/full compaction paths", () => {
    const providerId = `fork-env-test-${crypto.randomUUID()}` as ProviderId;
    const model = "fork-env-test-model";
    const envBackup: Record<string, string | undefined> = {};
    const envKeys = [
      "OTHERSIDE_AUTO_COMPACT_WINDOW",
      "OTHERSIDE_MICROCOMPACT",
      "OTHERSIDE_MICROCOMPACT_KEEP",
      "OTHERSIDE_MICROCOMPACT_RATIO",
      "OTHERSIDE_DISABLE_MICROCOMPACT",
    ];

    beforeEach(() => {
      resetRuntimeModelsForTests();
      registerRuntimeModel({
        id: model,
        displayName: model,
        contextWindow: 200_000,
        provider: providerId,
        efforts: [],
        defaultEffort: null,
      });
      for (const key of envKeys) {
        envBackup[key] = process.env[key];
      }
    });

    afterEach(() => {
      resetRuntimeModelsForTests();
      for (const key of envKeys) {
        if (envBackup[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = envBackup[key];
        }
      }
    });

    it("blocking path uses resolved window under env override", () => {
      const ctx = makeCtx(providerId, model, "/mock-cwd");
      const fork: Message[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
      // With 80,000 tokens
      const lastUsage = {
        inputTokens: 80_000,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      };

      // Without env override: context window is 200,000. Limit is 177,000.
      // 80,000 is under the limit.
      expect(isForkOverBlockingLimit(fork, ctx, lastUsage)).toBe(false);

      // With env override: context window is 100,000. Limit is 77,000.
      // 80,000 is over the limit.
      process.env.OTHERSIDE_AUTO_COMPACT_WINDOW = "100k";
      expect(isForkOverBlockingLimit(fork, ctx, lastUsage)).toBe(true);
    });

    it("micro compact path uses resolved window under env override", () => {
      const ctx = makeCtx(providerId, model, "/mock-cwd");

      // We set up micro compact settings
      process.env.OTHERSIDE_MICROCOMPACT = "token";
      process.env.OTHERSIDE_MICROCOMPACT_KEEP = "1";
      process.env.OTHERSIDE_MICROCOMPACT_RATIO = "0.04";
      delete process.env.OTHERSIDE_DISABLE_MICROCOMPACT;

      // We have a tool use and a tool result
      const fork: Message[] = [
        { role: "system", content: [{ type: "text", text: "sys" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "Read", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "some long content" }],
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_2", name: "Read", input: {} }],
          usage: {
            inputTokens: 5_000,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_2", content: "some long content 2" }],
        },
      ];

      // Case 1: Without override, window is 200k.
      // Auto compact threshold is 180k.
      // used = 5000 tokens.
      // ratio = 5000 / 180k = 0.027 < OTHERSIDE_MICROCOMPACT_RATIO (0.04).
      // Should NOT micro-compact.
      maybeMicroCompactFork(fork, ctx, null, () => {});
      const block1 = fork[2]?.content[0];
      expect(block1?.type).toBe("tool_result");
      if (block1 && block1.type === "tool_result") {
        expect(block1.content).not.toBe("[Old tool result content cleared]");
      }

      // Case 2: With override, window is 100k.
      // Auto compact threshold is 80k.
      // used = 5000 tokens.
      // ratio = 5000 / 80k = 0.0625 >= OTHERSIDE_MICROCOMPACT_RATIO (0.04).
      // Should micro-compact.
      process.env.OTHERSIDE_AUTO_COMPACT_WINDOW = "100k";

      let sidechainRecordAppended = false;
      maybeMicroCompactFork(fork, ctx, null, (rec) => {
        if (
          rec.type === "content_replacement" &&
          rec.replacement === "[Old tool result content cleared]"
        ) {
          sidechainRecordAppended = true;
        }
      });

      const block2 = fork[2]?.content[0];
      expect(block2?.type).toBe("tool_result");
      if (block2 && block2.type === "tool_result") {
        expect(block2.content).toBe("[Old tool result content cleared]");
      }
      // The second tool result should remain intact
      const block3 = fork[4]?.content[0];
      expect(block3?.type).toBe("tool_result");
      if (block3 && block3.type === "tool_result") {
        expect(block3.content).toBe("some long content 2");
      }
      expect(sidechainRecordAppended).toBe(true);
    });

    it("full/auto compact path uses resolved window under env override", async () => {
      const ctx = makeCtx(providerId, model, "/mock-cwd");

      // Mock provider behavior for compaction summarization
      const captures: Capture[] = [];
      registerScriptedProvider(
        providerId,
        [successfulCompactCall("Compacted summary under test.")],
        captures,
      );

      const fork: Message[] = [
        { role: "system", content: [{ type: "text", text: "sys" }] },
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ];

      const lastUsage = {
        inputTokens: 100_000,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      };

      // Without env override: context window is 200,000. threshold is Math.min(180k, 177k) = 177k.
      // 100,000 is under the threshold. should skip.
      const resWithout = await maybeCompactFork(fork, ctx, lastUsage, []);
      expect(resWithout).toBe("skipped");

      // With env override: context window is 100,000. threshold is Math.min(80k, 77k) = 77k.
      // 100,000 is over the threshold. should compact.
      process.env.OTHERSIDE_AUTO_COMPACT_WINDOW = "100k";
      const resWith = await maybeCompactFork(fork, ctx, lastUsage, []);
      expect(resWith).toBe("compacted");
      expect(fork.length).toBe(2);
      expect(fork[0]?.role).toBe("system");
      expect(fork[1]?.role).toBe("user");
      const userBlock = fork[1]?.content[0];
      expect(userBlock?.type).toBe("text");
      if (userBlock && userBlock.type === "text") {
        expect(userBlock.text).toContain("Compacted summary under test.");
      }
    });
  });
});
