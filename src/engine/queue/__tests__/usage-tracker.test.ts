import { afterEach, describe, expect, it } from "bun:test";
import { mergeUsageSnap } from "@/engine/queue/runtime/turn/stream.ts";
import { createTurnUsageTracker } from "@/engine/queue/turn/usage-tracker.ts";
import {
  clearLastUsage,
  getLastUsage,
  hasServerUsage,
} from "@/engine/session/compact/last-usage.ts";
import { countTokensWithEstimates } from "@/engine/session/compact/token-count.ts";
import {
  type AssistantMessageRecord,
  type AssistantRequestUsage,
  lineToRecords,
  recordsFromParsedLine,
  Session,
  serializeRecord,
} from "@/engine/session/record/index.ts";
import {
  latestContextUsageSnapshotFromSessionRecords,
  usageSnapshotFromAssistantUsage,
} from "@/engine/session/state.ts";
import { sessionRecordsToMessages } from "@/engine/session/transcript/to-messages.ts";
import {
  emptyTokenTotals,
  totalTokenTotals,
  type UsageByProvider,
} from "@/engine/session/usage/provider.ts";
import { createRecordProviderUsage } from "@/engine/session/usage/record-provider-usage.ts";
import {
  type ContextUsageSnapshot,
  mergeContextUsageSnapshot,
} from "@/engine/session/usage/snapshot.ts";
import {
  mainTokenTotalsFromRecords,
  usageByProviderFromRecords,
} from "@/engine/session/usage/store.ts";
import type { BrokerState } from "@/kernel/std/types/request.ts";

const state: BrokerState = {
  provider: "anthropic-cloud",
  model: "claude-sonnet-5-5",
  effort: null,
  fastMode: false,
  permissionMode: "default",
  orchestrationMode: "disabled",
};
const billing = {
  inputTokens: 150_000,
  outputTokens: 10_000,
  cacheCreationInputTokens: 15_000,
  cacheReadInputTokens: 25_000,
};

function fixture() {
  const session = new Session("usage-test", "/workspace");
  const usage: {
    totals: ReturnType<typeof emptyTokenTotals>;
    context: ContextUsageSnapshot;
    providers: UsageByProvider;
    offline: UsageByProvider;
  } = {
    totals: emptyTokenTotals(),
    context: emptyTokenTotals(),
    providers: {},
    offline: {},
  };
  const record = createRecordProviderUsage({
    session,
    setMainTokenTotals: (update) => {
      usage.totals = update(usage.totals);
    },
    setMainLastContext: (snapshot) => {
      usage.context = snapshot;
    },
    setContextWarningSuppressed: () => {},
    setUsageByProvider: (update) => {
      usage.providers = update(usage.providers);
    },
    setOfflineUsageByProvider: (update) => {
      usage.offline = update(usage.offline);
    },
  });
  const tracker = createTurnUsageTracker({
    session,
    turnState: state,
    recordProviderUsage: record,
    mergeContextUsageSnapshot,
    setProgressInputTokens: () => {},
    setLiveOutputTokens: () => {},
  });
  return { session, usage, tracker, record };
}

function assistant(usage: AssistantRequestUsage, content = "answer"): AssistantMessageRecord {
  return {
    type: "assistant_message",
    ts: "2026-01-01T00:00:00.000Z",
    content,
    usage,
    provider: state.provider,
    model: state.model,
  };
}

afterEach(clearLastUsage);

describe("context snapshots stay separate from billed usage", () => {
  it("records 200k billed tokens while runtime context is 50k", () => {
    const { usage, tracker } = fixture();
    tracker.applyUsageEvent({ ...billing, contextTokens: 50_000 });
    expect(totalTokenTotals(usage.totals)).toBe(200_000);
    expect(usage.providers["anthropic-cloud"]).toEqual({
      ...billing,
      thoughtTokens: 0,
      requestCount: 1,
      lastModel: state.model,
    });
    expect(usage.offline).toEqual(usage.providers);
    expect(usage.context).toEqual({ ...billing, contextTokens: 50_000 });
    expect(countTokensWithEstimates([], getLastUsage())).toBe(50_000);
    const stamp = tracker.takeRequestUsageStamp();
    expect(stamp).not.toBeNull();
    expect(stamp?.contextTokens).toBe(50_000);
    expect(stamp?.input_tokens).toBe(150_000);
    expect(stamp?.output_tokens).toBe(10_000);
  });

  it("replaces snapshots without spend and stamps the latest independently of deltas", () => {
    const { usage, tracker } = fixture();
    tracker.applyUsageEvent({ ...billing, contextTokens: 50_000 });
    expect(tracker.takeRequestUsageStamp()?.request_count).toBe(1);
    tracker.applyUsageEvent({ contextTokens: 40_000 });
    tracker.applyUsageEvent({ contextTokens: 30_000 });
    tracker.applyUsageEvent({ outputTokens: 10_000 });
    expect(tracker.takeRequestUsageStamp()).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      thought_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      request_count: 0,
      contextTokens: 30_000,
    });
    expect(tracker.takeRequestUsageStamp()).toBeNull();
    expect(usage.context.contextTokens).toBe(30_000);
    expect(usage.providers["anthropic-cloud"]?.requestCount).toBe(1);
    expect(totalTokenTotals(usage.totals)).toBe(200_000);
  });

  it("accepts a zero-only snapshot without inventing billing or requests", () => {
    const { tracker, usage, record } = fixture();
    tracker.applyUsageEvent({ contextTokens: 0 });
    expect(usage.context.contextTokens).toBe(0);
    expect(countTokensWithEstimates([], getLastUsage())).toBe(0);
    expect(usage.providers).toEqual({});
    expect(tracker.takeRequestUsageStamp()?.request_count).toBe(0);
    record("anthropic-cloud", state.model, 0, 0, 0, 0, 0, {
      isFork: true,
      countRequest: false,
      contextUsage: { ...billing, contextTokens: 90_000 },
    });
    expect(usage.context.contextTokens).toBe(0);
    expect(getLastUsage()?.contextTokens).toBe(0);
  });

  it("keeps event shapes and billing unchanged when no snapshot is provided", () => {
    const { tracker, usage } = fixture();
    tracker.applyUsageEvent(billing);
    expect(usage.context).toEqual(billing);
    expect(tracker.takeRequestUsageStamp()).toEqual({
      input_tokens: 150_000,
      output_tokens: 10_000,
      thought_tokens: 0,
      cache_creation_input_tokens: 15_000,
      cache_read_input_tokens: 25_000,
      request_count: 1,
    });
    tracker.resetForMessageStart();
    tracker.applyUsageEvent({ ...billing, contextTokens: 50_000 });
    tracker.takeRequestUsageStamp();
    tracker.resetForMessageStart();
    tracker.applyUsageEvent(billing);
    expect(usage.context).toEqual(billing);
    expect(tracker.takeRequestUsageStamp()).not.toHaveProperty("contextTokens");
  });

  it("merges runtime attempts using the latest context rather than summing it", () => {
    const first = mergeUsageSnap(null, { kind: "usage", ...billing, contextTokens: 50_000 });
    const next = mergeUsageSnap(first, { kind: "usage", contextTokens: 40_000 });
    expect(next).toEqual({ ...billing, contextTokens: 40_000 });
    expect(mergeUsageSnap(next, { kind: "usage", outputTokens: 11_000 })).toEqual({
      ...billing,
      outputTokens: 11_000,
      contextTokens: 40_000,
    });
    expect(mergeUsageSnap(null, { kind: "usage", ...billing })).toEqual(billing);
    expect(mergeUsageSnap(next, { kind: "usage", contextTokens: 0 }).contextTokens).toBe(0);
  });

  it("persists/resumes the latest context-only stamp without changing the billing ledger", () => {
    const { session, tracker } = fixture();
    tracker.applyUsageEvent({ ...billing, contextTokens: 50_000 });
    const first = tracker.takeRequestUsageStamp();
    if (!first) throw new Error("missing billed usage stamp");
    tracker.applyUsageEvent({ contextTokens: 40_000 });
    const latest = tracker.takeRequestUsageStamp();
    if (!latest) throw new Error("missing context-only stamp");
    const records = [assistant(first), assistant(latest, "")];
    const lines = records.map((record) => serializeRecord(record, session.chain, session.stamp()));
    const restored = lines.flatMap(lineToRecords);
    expect(lines[1]).toContain('"contextTokens":40000');
    expect(latestContextUsageSnapshotFromSessionRecords(restored)?.contextTokens).toBe(40_000);
    const messages = sessionRecordsToMessages(restored);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.usage?.contextTokens).toBe(40_000);
    expect(countTokensWithEstimates(messages, null)).toBe(40_000);
    expect(totalTokenTotals(mainTokenTotalsFromRecords(restored))).toBe(200_000);
    expect(usageByProviderFromRecords(restored)["anthropic-cloud"]?.requestCount).toBe(1);

    const consecutive = sessionRecordsToMessages([
      assistant(first),
      assistant({ ...latest, contextTokens: 35_000 }, "new answer"),
    ]);
    expect(consecutive).toHaveLength(1);
    expect(consecutive[0]?.usage?.contextTokens).toBe(35_000);
    const sidechain = { ...assistant({ ...latest, contextTokens: 95_000 }), isSidechain: true };
    expect(
      latestContextUsageSnapshotFromSessionRecords([...restored, sidechain])?.contextTokens,
    ).toBe(40_000);
  });

  it("round-trips an explicit invalidation without reviving 50k or using 200k billing", () => {
    const { session, tracker, usage } = fixture();
    tracker.applyUsageEvent({ ...billing, contextTokens: 50_000 });
    const first = tracker.takeRequestUsageStamp();
    if (!first) throw new Error("missing initial stamp");
    expect(hasServerUsage()).toBe(true);
    tracker.applyUsageEvent({ contextTokens: null });
    tracker.applyUsageEvent({ outputTokens: billing.outputTokens });
    expect(usage.context.contextTokens).toBeNull();
    expect(getLastUsage()?.contextTokens).toBeNull();
    expect(hasServerUsage()).toBe(false);
    expect(totalTokenTotals(usage.totals)).toBe(200_000);
    const invalidation = tracker.takeRequestUsageStamp();
    if (!invalidation) throw new Error("missing invalidation stamp");
    expect(invalidation).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      thought_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      request_count: 0,
      contextTokens: null,
    });
    const records = [assistant(first, "x".repeat(40)), assistant(invalidation, "")];
    const lines = records.map((record) => serializeRecord(record, session.chain, session.stamp()));
    expect(lines[1]).toContain('"contextTokens":null');
    const restored = lines.flatMap(lineToRecords);
    const last = latestContextUsageSnapshotFromSessionRecords(restored);
    expect(last?.contextTokens).toBeNull();
    const messages = sessionRecordsToMessages(restored);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.usage?.contextTokens).toBeNull();
    expect(countTokensWithEstimates(messages, last)).toBe(10);
    expect(totalTokenTotals(mainTokenTotalsFromRecords(restored))).toBe(200_000);
    expect(usageByProviderFromRecords(restored)["anthropic-cloud"]?.requestCount).toBe(1);
    const { contextTokens: _contextTokens, ...partial } = invalidation;
    const coalesced = sessionRecordsToMessages([
      assistant(first),
      assistant(invalidation, "new inference"),
      assistant(partial, "more text"),
    ]);
    expect(coalesced).toHaveLength(1);
    expect(coalesced[0]?.usage?.contextTokens).toBeNull();
  });

  it("distinguishes absent partials, invalidation, zero, and a new valid snapshot", () => {
    const first = mergeUsageSnap(null, { kind: "usage", ...billing, contextTokens: 50_000 });
    expect(
      mergeUsageSnap(first, { kind: "usage", outputTokens: billing.outputTokens }).contextTokens,
    ).toBe(50_000);
    const unknown = mergeUsageSnap(first, { kind: "usage", contextTokens: null });
    expect(unknown).toEqual({ ...billing, contextTokens: null });
    expect(
      mergeUsageSnap(unknown, { kind: "usage", inputTokens: billing.inputTokens }).contextTokens,
    ).toBeNull();
    const zero = mergeUsageSnap(unknown, { kind: "usage", contextTokens: 0 });
    expect(zero.contextTokens).toBe(0);
    expect(
      mergeUsageSnap(zero, { kind: "usage", outputTokens: billing.outputTokens }).contextTokens,
    ).toBe(0);
    expect(mergeUsageSnap(zero, { kind: "usage", contextTokens: 30_000 }).contextTokens).toBe(
      30_000,
    );
    expect(mergeUsageSnap(null, { kind: "usage", ...billing })).toEqual(billing);
  });

  it("retains explicit null at both local and foreign persistence boundaries", () => {
    for (const sidecar of [undefined, { contextTokens: null, requestCount: 0 }]) {
      const records = recordsFromParsedLine({
        type: "assistant",
        timestamp: "2026-01-01T00:00:00Z",
        message: { content: [{ type: "text", text: "answer" }], usage: { contextTokens: null } },
        ...(sidecar ? { _os: sidecar } : {}),
      });
      const record = records[0];
      if (record?.type !== "assistant_message" || !record.usage)
        throw new Error("missing context stamp");
      expect(record.usage.contextTokens).toBeNull();
      expect(record.usage.request_count).toBe(0);
      expect(usageSnapshotFromAssistantUsage(record.usage).contextTokens).toBeNull();
    }
  });

  it("validates persisted context at the boundary, preserving zero and omitting invalid values", () => {
    const stamp: AssistantRequestUsage = {
      input_tokens: 1,
      output_tokens: 2,
      thought_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      request_count: 1,
    };
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      expect(
        usageSnapshotFromAssistantUsage({ ...stamp, contextTokens: invalid }),
      ).not.toHaveProperty("contextTokens");
      const decoded = recordsFromParsedLine({
        type: "assistant",
        timestamp: "2026-01-01T00:00:00Z",
        message: { content: [{ type: "text", text: "answer" }], usage: stamp },
        _os: { contextTokens: invalid, requestCount: 1 },
      });
      expect(decoded[0]?.type).toBe("assistant_message");
      if (decoded[0]?.type === "assistant_message")
        expect(decoded[0].usage).not.toHaveProperty("contextTokens");
    }
    expect(usageSnapshotFromAssistantUsage({ ...stamp, contextTokens: 0 }).contextTokens).toBe(0);
    expect(
      latestContextUsageSnapshotFromSessionRecords([assistant({ ...stamp, contextTokens: 0 })])
        ?.contextTokens,
    ).toBe(0);
    expect(usageSnapshotFromAssistantUsage(stamp)).not.toHaveProperty("contextTokens");
    const { session } = fixture();
    expect(serializeRecord(assistant(stamp), session.chain, session.stamp())).not.toContain(
      "contextTokens",
    );
  });

  it("stamps the final fresh/cached split when an earlier event reported the whole prompt as fresh", () => {
    const { tracker } = fixture();
    tracker.applyUsageEvent({ inputTokens: 637_662, cacheReadInputTokens: 0, thoughtTokens: 120 });
    tracker.applyUsageEvent({
      inputTokens: 701,
      cacheReadInputTokens: 637_662,
      outputTokens: 332,
      thoughtTokens: 400,
    });
    const stamp = tracker.takeRequestUsageStamp();
    expect(stamp).toEqual({
      input_tokens: 701,
      output_tokens: 332,
      thought_tokens: 400,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 637_662,
      request_count: 1,
    });
  });
});
