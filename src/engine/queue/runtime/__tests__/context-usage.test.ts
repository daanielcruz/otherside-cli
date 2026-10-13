import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { registerRuntimeModel, resetRuntimeModelsForTests } from "@/engine/model/catalog.ts";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import { maybeCompact } from "@/engine/queue/runtime/compact/auto.ts";
import { checkContextOverflow } from "@/engine/queue/runtime/compact/overflow.ts";
import {
  type CompactOrchestrationDeps,
  computeUsedContextTokens,
} from "@/engine/queue/runtime/compact/support.ts";
import { Session } from "@/engine/session/record/index.ts";
import { makeQueue } from "@/harness/composer/queue.ts";
import { DEFAULT_CONFIG } from "@/kernel/config/config.ts";
import type { AgentEvent } from "@/kernel/std/types/events.ts";
import type { MessageUsageSnapshot } from "@/kernel/std/types/message.ts";
import type { BrokerState } from "@/kernel/std/types/request.ts";

const MODEL = "context-snapshot-test";
const state: BrokerState = {
  provider: "xai",
  model: MODEL,
  effort: null,
  fastMode: false,
  permissionMode: "default",
  orchestrationMode: "disabled",
};

function fixture(usage: MessageUsageSnapshot): CompactOrchestrationDeps {
  const session = new Session("context-snapshot", "/workspace");
  session.messages.push({
    role: "assistant",
    usage,
    content: [{ type: "text", text: "x".repeat(400_000) }],
  });
  return {
    agentDeps: {
      session,
      broker: { read: () => state, dispatch: () => {} },
      config: { ...DEFAULT_CONFIG, defaultProvider: state.provider, defaultModel: MODEL },
      getLastUsage: () => usage,
    },
    state: {
      rapidRefillBreakerOpen: false,
      rapidRefillCount: 0,
      consecutiveCompactFailures: 0,
      turnsSinceLast: Number.POSITIVE_INFINITY,
      lastAutoCompactAttemptTurnId: null,
    },
    turnId: "turn",
    activeAbortController: () => null,
    setActiveAbortController: () => {},
    injections: makeQueue(),
    makeCtx: () => ({ ...state, sessionId: session.id, cwd: session.cwd }),
  };
}

beforeEach(() => {
  registerAllProviders();
  registerRuntimeModel({
    id: MODEL,
    provider: "xai",
    displayName: MODEL,
    contextWindow: 200_000,
    autoCompactTokenLimit: 150_000,
    efforts: [],
    defaultEffort: null,
  });
});
afterEach(resetRuntimeModelsForTests);

describe("runtime active-context limits", () => {
  it("does not compact a 50k context just because billing reaches 200k", async () => {
    const usage = {
      inputTokens: 190_000,
      outputTokens: 10_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      contextTokens: 50_000,
    };
    const deps = fixture(usage);
    expect(computeUsedContextTokens(deps.agentDeps.session.messages, usage, "xai", MODEL)).toBe(
      50_000,
    );
    expect(checkContextOverflow(deps)).toBeNull();
    const events: AgentEvent[] = [];
    for await (const event of maybeCompact(deps)) events.push(event);
    expect(events).toEqual([]);
    expect(deps.agentDeps.session.messages).toHaveLength(1);
    expect(usage.inputTokens + usage.outputTokens).toBe(200_000);
  });

  it("uses message and harness estimates after null rather than the 200k billing total", async () => {
    const usage = {
      inputTokens: 190_000,
      outputTokens: 10_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      contextTokens: null,
    };
    const deps = fixture(usage);
    expect(computeUsedContextTokens(deps.agentDeps.session.messages, usage, "xai", MODEL)).toBe(
      113_000,
    );
    expect(checkContextOverflow(deps)).toBeNull();
    const events: AgentEvent[] = [];
    for await (const event of maybeCompact(deps)) events.push(event);
    expect(events).toEqual([]);
    expect(usage.inputTokens + usage.outputTokens).toBe(200_000);
  });

  it("does not infer an incompressible prefix from aggregated billing input", () => {
    const usage = {
      inputTokens: 490_000,
      outputTokens: 10_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      contextTokens: 200_000,
    };
    expect(checkContextOverflow(fixture(usage))?.kind).toBe("compactible");
    const { contextTokens: _contextTokens, ...legacy } = usage;
    expect(checkContextOverflow(fixture(legacy))?.kind).toBe("prefix");
  });
});
