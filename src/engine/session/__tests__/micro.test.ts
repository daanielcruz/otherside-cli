import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { registerRuntimeModel, resetRuntimeModelsForTests } from "@/engine/model/catalog.ts";
import { maybeMicroCompact } from "@/engine/queue/runtime/compact/micro.ts";
import type { CompactOrchestrationDeps } from "@/engine/queue/runtime/compact/support.ts";
import { Session } from "@/engine/session/record/state.ts";
import { sessionRecordsToMessages } from "@/engine/session/transcript/to-messages.ts";
import type { InjectionQueue } from "@/harness/composer/injections.ts";
import type { UserConfig } from "@/kernel/config/config.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { BrokerHandle, RequestContext } from "@/kernel/std/types/request.ts";
import { applyTokenBasedMicroCompact, MICRO_COMPACT_CLEARED_MESSAGE } from "../compact/micro.ts";

describe("microcompact and session heap pruning", () => {
  const originalMicrocompactEnv = process.env.OTHERSIDE_MICROCOMPACT;

  beforeEach(() => {
    process.env.OTHERSIDE_MICROCOMPACT = "true";
  });

  afterEach(() => {
    resetRuntimeModelsForTests();
    delete process.env.OTHERSIDE_MICROCOMPACT_KEEP;
    delete process.env.OTHERSIDE_MICROCOMPACT_RATIO;
    if (originalMicrocompactEnv !== undefined) {
      process.env.OTHERSIDE_MICROCOMPACT = originalMicrocompactEnv;
    } else {
      delete process.env.OTHERSIDE_MICROCOMPACT;
    }
  });

  it("clears old tool results and returns cleared tool use ids, respecting keepRecent", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "Read", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "raw content 1" }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-2", name: "Read", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-2", content: "raw content 2" }],
      },
    ];

    const outcome = applyTokenBasedMicroCompact({
      messages,
      usedTokens: 90,
      threshold: 100,
      config: {
        enabled: true,
        mode: "token",
        keepRecent: 1,
        triggerRatio: 0.8,
      },
    });

    expect(outcome).not.toBeNull();
    expect(outcome?.cleared).toBe(1);
    expect(outcome?.kept).toBe(1);
    expect(outcome?.clearedToolUseIds).toEqual(["call-1"]);

    expect(messages[1]?.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "call-1",
      content: MICRO_COMPACT_CLEARED_MESSAGE,
    });

    expect(messages[3]?.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "call-2",
      content: "raw content 2",
    });
  });

  it("maybeMicroCompact appends content_replacement records to session", async () => {
    const session = new Session("session-test-id", "/test/cwd");
    session.pushRecord({
      type: "tool_call",
      ts: "2026-06-23T00:00:00.000Z",
      call_id: "call-1",
      tool_name: "Read",
      args: {},
    });
    session.pushRecord({
      type: "tool_result",
      ts: "2026-06-23T00:00:00.000Z",
      call_id: "call-1",
      result: "raw content 1",
      is_error: false,
    });
    session.pushRecord({
      type: "tool_call",
      ts: "2026-06-23T00:00:00.000Z",
      call_id: "call-2",
      tool_name: "Read",
      args: {},
    });
    session.pushRecord({
      type: "tool_result",
      ts: "2026-06-23T00:00:00.000Z",
      call_id: "call-2",
      result: "raw content 2",
      is_error: false,
    });

    session.messages.push(
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "Read", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "raw content 1" }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-2", name: "Read", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-2", content: "raw content 2" }],
      },
    );

    registerRuntimeModel({
      id: "claude-3-5-sonnet",
      displayName: "Claude 3.5 Sonnet",
      contextWindow: 200000,
      provider: "anthropic",
      efforts: [],
      defaultEffort: null,
    });

    const brokerMock: BrokerHandle = {
      read: () => ({
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        effort: null,
        fastMode: false,
        permissionMode: "default",
        orchestrationMode: "disabled" as const,
      }),
      dispatch: () => {},
    };
    const config: UserConfig = {
      defaultProvider: "anthropic",
      defaultModel: "claude-3-5-sonnet",
      autoCompact: true,
    };
    const injections: InjectionQueue = {
      drain: () => [],
      peek: () => [],
      push: () => {},
    };
    const requestContext: RequestContext = {
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      effort: null,
      permissionMode: "default",
      sessionId: session.id,
      cwd: process.cwd(),
    };

    const deps: CompactOrchestrationDeps = {
      agentDeps: {
        broker: brokerMock,
        session,
        config,
        getLastUsage: () => null,
      },
      state: {
        rapidRefillBreakerOpen: false,
        rapidRefillCount: 0,
        consecutiveCompactFailures: 0,
        turnsSinceLast: 0,
        lastAutoCompactAttemptTurnId: null,
      },
      turnId: "turn-1",
      activeAbortController: () => null,
      setActiveAbortController: () => {},
      injections,
      makeCtx: () => requestContext,
    };

    process.env.OTHERSIDE_MICROCOMPACT_KEEP = "1";
    process.env.OTHERSIDE_MICROCOMPACT_RATIO = "0.00001";

    const events = [];
    for await (const event of maybeMicroCompact(deps)) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("micro_compact");

    const replacementRecords = session.records.filter((r) => r.type === "content_replacement");
    expect(replacementRecords).toHaveLength(1);
    expect(replacementRecords[0]).toMatchObject({
      type: "content_replacement",
      kind: "tool-result",
      toolUseId: "call-1",
      replacement: MICRO_COMPACT_CLEARED_MESSAGE,
    });

    const parsedMessages = sessionRecordsToMessages(session.records);
    expect(parsedMessages).toHaveLength(2);
    expect(parsedMessages[1]?.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "call-1",
      content: MICRO_COMPACT_CLEARED_MESSAGE,
    });
    expect(parsedMessages[1]?.content[1]).toEqual({
      type: "tool_result",
      tool_use_id: "call-2",
      content: "raw content 2",
    });
  });
});
