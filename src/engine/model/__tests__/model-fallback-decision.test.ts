import { describe, expect, test } from "bun:test";
import {
  type ModelFallbackDeviation,
  rankOneCooldownDeviation,
  resolveWithModelFallbackDecision,
} from "@/engine/model/facts/model-fallback-decision.ts";
import type { TierCandidateDetail } from "@/engine/model/tier/resolver.ts";
import { clear, pending } from "@/kernel/channels/ask.ts";
import type { ProviderId } from "@/kernel/config/provider-ids.ts";
import { setRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";

function candidate(input: {
  rank: number;
  provider: ProviderId;
  model: string;
  usable: boolean;
  cooldownUntilEpochMs: number | null;
  blockedReasons?: string[];
}): TierCandidateDetail {
  const blockedReasons = input.blockedReasons ?? [];
  return {
    tier: "emperor",
    rank: input.rank,
    provider: input.provider,
    model: input.model,
    resolution: { provider: input.provider, model: input.model },
    usable: input.usable,
    blocked: !input.usable,
    quotaBlocked: false,
    unobservedProvider: false,
    summary: input.usable ? "routeable" : `blocked: ${blockedReasons.join(", ")}`,
    notes: [],
    blockedReasons,
    credentialsConfigured: true,
    modelAvailable: true,
    cooldownUntilEpochMs: input.cooldownUntilEpochMs,
    routing: {
      trackingStatus: "tracked",
      utilizationPct: null,
      balanceStatus: "available",
      observedAtEpochMs: 1,
      resetsAtEpochMs: null,
      source: "explicit",
    },
  };
}

function deviation(untilEpochMs = Date.now() + 60_000): ModelFallbackDeviation {
  const rankOne = candidate({
    rank: 1,
    provider: "codex",
    model: "top-model",
    usable: false,
    cooldownUntilEpochMs: untilEpochMs,
    blockedReasons: ["rate limited"],
  });
  const substitute = candidate({
    rank: 2,
    provider: "antigravity",
    model: "backup-model",
    usable: true,
    cooldownUntilEpochMs: null,
  });
  const found = rankOneCooldownDeviation("emperor", [rankOne, substitute], substitute);
  if (found === null) throw new Error("expected fallback deviation");
  return found;
}

describe("resolveWithModelFallbackDecision", () => {
  test("timeout accepts the fallback and clears the pending question", async () => {
    setRuntimeKind("interactive");
    clear();
    try {
      const result = await resolveWithModelFallbackDecision({
        resolve: () => "fallback",
        inspect: () => deviation(),
        timeoutMs: 1,
      });

      expect(result).toEqual({
        value: "fallback",
        decision: "use_fallback",
        asked: true,
        waited: false,
        timedOut: true,
      });
      expect(pending()).toHaveLength(0);
    } finally {
      clear();
      setRuntimeKind(null);
    }
  });

  test("wait pauses until cooldown expiry and resolves again", async () => {
    const untilEpochMs = Date.now() + 20_000;
    const slept: number[] = [];
    let resolveCount = 0;

    const result = await resolveWithModelFallbackDecision({
      resolve: () => {
        resolveCount += 1;
        return resolveCount === 1 ? "fallback" : "rank-one";
      },
      inspect: (value) => (value === "fallback" ? deviation(untilEpochMs) : null),
      runtimeKind: () => "interactive",
      decisionHook: async () => ({ decision: "wait", timedOut: false }),
      sleepUntil: async (until) => {
        slept.push(until);
      },
    });

    expect(result).toEqual({
      value: "rank-one",
      decision: "wait",
      asked: true,
      waited: true,
      timedOut: false,
    });
    expect(slept).toEqual([untilEpochMs]);
    expect(resolveCount).toBe(2);
  });

  test("print mode uses the fallback without asking", async () => {
    let asked = false;
    let resolveCount = 0;

    const result = await resolveWithModelFallbackDecision({
      resolve: () => {
        resolveCount += 1;
        return "fallback";
      },
      inspect: () => deviation(),
      runtimeKind: () => "print",
      decisionHook: async () => {
        asked = true;
        return { decision: "wait", timedOut: false };
      },
    });

    expect(result).toEqual({
      value: "fallback",
      decision: "use_fallback",
      asked: false,
      waited: false,
      timedOut: false,
    });
    expect(asked).toBe(false);
    expect(resolveCount).toBe(1);
  });
});
