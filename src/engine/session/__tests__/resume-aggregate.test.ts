import { describe, expect, test } from "bun:test";
import type { AssistantMessageRecord, SessionRecord } from "@/engine/session/record/schema.ts";
import { aggregateDiscardedHistory } from "@/engine/session/resume-aggregate.ts";
import { latestContextUsageSnapshotFromSessionRecords } from "@/engine/session/state.ts";
import {
  mainTokenTotalsFromRecords,
  usageByProviderFromRecords,
} from "@/engine/session/usage/store.ts";

const SESSION_ID = "session-under-test";

function assistantLine(
  ts: string,
  tokens: { input: number; output: number; cacheRead?: number },
  route: { provider: string; model: string } = { provider: "anthropic", model: "claude-opus-5" },
): AssistantMessageRecord {
  return {
    type: "assistant_message",
    ts,
    uuid: `assistant-${ts}`,
    content: "",
    usage: {
      input_tokens: tokens.input,
      output_tokens: tokens.output,
      thought_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: tokens.cacheRead ?? 0,
      request_count: 1,
    },
    provider: route.provider,
    model: route.model,
  };
}

function userLine(ts: string, permissionMode: string): SessionRecord {
  return {
    type: "user_message",
    ts,
    uuid: `user-${ts}`,
    content: "",
    permissionMode,
  } as SessionRecord;
}

/** A discarded region of `count` assistant lines, each spending one request. */
function discardedRegion(count: number): SessionRecord[] {
  const out: SessionRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(userLine(`2026-07-31T00:00:${String(i).padStart(2, "0")}.000Z`, "acceptEdits"));
    out.push(
      assistantLine(`2026-07-31T00:00:${String(i).padStart(2, "0")}.500Z`, {
        input: 10,
        output: 5,
        cacheRead: 1000,
      }),
    );
  }
  return out;
}

describe("discarded history aggregates", () => {
  test("collapses a large region to a handful of records", () => {
    const region = discardedRegion(500);
    const { records } = aggregateDiscardedHistory(region, SESSION_ID);
    expect(region.length).toBe(1000);
    expect(records.length).toBeLessThanOrEqual(4);
  });

  test("spend totals survive the collapse exactly", () => {
    const region = discardedRegion(500);
    const before = usageByProviderFromRecords(region);
    const after = usageByProviderFromRecords(aggregateDiscardedHistory(region, SESSION_ID).records);
    expect(after).toEqual(before);
  });

  test("main token totals survive the collapse exactly", () => {
    const region = discardedRegion(500);
    const before = mainTokenTotalsFromRecords(region);
    const after = mainTokenTotalsFromRecords(aggregateDiscardedHistory(region, SESSION_ID).records);
    expect(after).toEqual(before);
  });

  test("a rollup is never read as a context snapshot", () => {
    // 500 requests of 1010 context each: a summed record would answer ~505000,
    // which is the failure this separation exists to prevent.
    const region = discardedRegion(500);
    const { records } = aggregateDiscardedHistory(region, SESSION_ID);
    const snapshot = latestContextUsageSnapshotFromSessionRecords(records, {
      provider: "anthropic",
      model: "claude-opus-5",
    });
    expect(snapshot).not.toBeNull();
    const context =
      (snapshot?.inputTokens ?? 0) +
      (snapshot?.cacheReadInputTokens ?? 0) +
      (snapshot?.cacheCreationInputTokens ?? 0);
    expect(context).toBe(1010);
  });

  test("the context snapshot is the region's last request, not its first", () => {
    const region = [
      assistantLine("2026-07-31T00:00:01.000Z", { input: 10, output: 5, cacheRead: 100 }),
      assistantLine("2026-07-31T00:00:02.000Z", { input: 20, output: 5, cacheRead: 900 }),
    ];
    const { records } = aggregateDiscardedHistory(region, SESSION_ID);
    const snapshot = latestContextUsageSnapshotFromSessionRecords(records, {
      provider: "anthropic",
      model: "claude-opus-5",
    });
    expect((snapshot?.inputTokens ?? 0) + (snapshot?.cacheReadInputTokens ?? 0)).toBe(920);
  });

  test("each route keeps its own totals", () => {
    const region = [
      assistantLine("2026-07-31T00:00:01.000Z", { input: 10, output: 5 }),
      assistantLine(
        "2026-07-31T00:00:02.000Z",
        { input: 7, output: 3 },
        {
          provider: "codex",
          model: "gpt-5.6-sol",
        },
      ),
      assistantLine("2026-07-31T00:00:03.000Z", { input: 10, output: 5 }),
    ];
    const before = usageByProviderFromRecords(region);
    const after = usageByProviderFromRecords(aggregateDiscardedHistory(region, SESSION_ID).records);
    expect(after).toEqual(before);
    expect(Object.keys(after).sort()).toEqual(["anthropic", "codex"]);
  });

  test("a resumed session still reads as having a conversation", () => {
    // The sync gate asks whether any message record exists; history that plainly
    // happened must not answer no.
    const { records } = aggregateDiscardedHistory(discardedRegion(200), SESSION_ID);
    const hasMessages = records.some(
      (r) => r.type === "user_message" || r.type === "assistant_message",
    );
    expect(hasMessages).toBe(true);
  });

  test("the last permission mode reaches the broker restore", () => {
    const region = [
      userLine("2026-07-31T00:00:01.000Z", "acceptEdits"),
      userLine("2026-07-31T00:00:02.000Z", "plan"),
    ];
    const { records } = aggregateDiscardedHistory(region, SESSION_ID);
    const users = records.filter((r) => r.type === "user_message");
    expect(users.length).toBe(1);
    expect((users[0] as { permissionMode?: string }).permissionMode).toBe("plan");
  });

  test("records that are not conversation lines pass through untouched", () => {
    const mark: SessionRecord = {
      type: "compaction_mark",
      ts: "2026-07-31T00:00:01.000Z",
    } as SessionRecord;
    const { records } = aggregateDiscardedHistory([mark], SESSION_ID);
    expect(records).toEqual([mark]);
  });

  test("an empty region contributes nothing", () => {
    expect(aggregateDiscardedHistory([], SESSION_ID).records).toEqual([]);
  });
});
