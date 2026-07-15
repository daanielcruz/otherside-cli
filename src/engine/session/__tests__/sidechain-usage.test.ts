import { describe, expect, it } from "bun:test";
import { recordsFromParsedLine, type SessionRecord } from "@/engine/session/record/index.ts";
import { latestContextUsageSnapshotFromSessionRecords } from "@/engine/session/state.ts";
import {
  mainTokenTotalsFromRecords,
  usageByProviderFromRecords,
  usageRecordFromDelta,
} from "@/engine/session/usage/store.ts";

const MAIN_ASSISTANT_RECORD = {
  type: "assistant_message",
  ts: "2026-07-02T10:00:00.000Z",
  provider: "codex",
  model: "gpt-5.5-codex",
  content: [{ type: "text", text: "hi" }],
  usage: {
    request_count: 1,
    input_tokens: 1000,
    output_tokens: 50,
    thought_tokens: 0,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 3000,
  },
} as unknown as SessionRecord;

const FORK_USAGE_RECORD = usageRecordFromDelta({
  provider: "codex",
  model: "gpt-5.5-codex",
  sessionId: "s1",
  usage: {
    inputTokens: 90_000,
    outputTokens: 4000,
    thoughtTokens: 0,
    cacheCreationInputTokens: 10_000,
    cacheReadInputTokens: 60_000,
  },
  requestCount: 1,
  at: "2026-07-02T10:00:01.000Z",
  isSidechain: true,
}) as unknown as SessionRecord;

describe("fork usage record isolation", () => {
  it("usageRecordFromDelta stamps isSidechain when asked", () => {
    expect((FORK_USAGE_RECORD as { isSidechain?: boolean }).isSidechain).toBe(true);
  });

  it("context snapshot skips sidechain usage appended after the main turn", () => {
    const snapshot = latestContextUsageSnapshotFromSessionRecords([
      MAIN_ASSISTANT_RECORD,
      FORK_USAGE_RECORD,
    ]);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.inputTokens).toBe(1000);
    expect(snapshot?.cacheReadInputTokens).toBe(3000);
  });

  it("ledger fold still counts sidechain usage as provider spend", () => {
    const folded = usageByProviderFromRecords([MAIN_ASSISTANT_RECORD, FORK_USAGE_RECORD]);
    expect(folded.codex?.inputTokens).toBe(91_000);
    expect(folded.codex?.outputTokens).toBe(4050);
  });

  it("main token totals exclude sidechain usage", () => {
    const totals = mainTokenTotalsFromRecords([MAIN_ASSISTANT_RECORD, FORK_USAGE_RECORD]);
    expect(totals.inputTokens).toBe(1000);
    expect(totals.outputTokens).toBe(50);
    expect(totals.cacheReadInputTokens).toBe(3000);
  });

  it("counts a bare usage record parsed via recordsFromParsedLine", () => {
    const parsed = recordsFromParsedLine({
      type: "usage",
      ts: "2026-07-02T10:00:02.000Z",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      session_id: "s1",
      input_tokens: 500,
      output_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.type).toBe("usage");
    const folded = usageByProviderFromRecords(parsed);
    expect(folded.anthropic?.inputTokens).toBe(500);
    expect(folded.anthropic?.outputTokens).toBe(100);
  });
});
