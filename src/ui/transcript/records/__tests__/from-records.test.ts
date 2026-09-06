import { describe, expect, it } from "bun:test";
import { INTERRUPT_MESSAGE } from "@/engine/queue/runtime/interruption-text.ts";
import type { SessionRecord } from "@/engine/session/index.ts";
import { sessionRecordsToTranscript } from "@/ui/transcript/records/from-records.ts";
import { mapTranscriptEntries } from "@/ui/transcript/string-view-store.ts";
import { renderSettledEntries } from "@/ui/transcript/string-view-transcript.ts";

const TS = "2026-01-01T00:00:00.000Z";
const WIDTH = 80;

function assistantRecord(content: string): SessionRecord {
  return { type: "assistant_message", ts: TS, content };
}

function userRecord(content: string, isMeta = false): SessionRecord {
  return { type: "user_message", ts: TS, content, ...(isMeta ? { isMeta: true } : {}) };
}

function renderReplay(records: SessionRecord[]): string[] {
  return renderSettledEntries(
    WIDTH,
    mapTranscriptEntries(sessionRecordsToTranscript(records)),
    "compact",
  );
}

describe("sessionRecordsToTranscript — interruption marker", () => {
  it("replays the cancel marker as the system entry the live view pushed", () => {
    const entries = sessionRecordsToTranscript([
      assistantRecord("partial answer"),
      userRecord(INTERRUPT_MESSAGE, true),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(["assistant", "system"]);
    expect(entries[1]?.text).toBe(INTERRUPT_MESSAGE);
  });

  it("hugs the block it cut short instead of opening its own", () => {
    const lines = renderReplay([
      assistantRecord("partial answer"),
      userRecord(INTERRUPT_MESSAGE, true),
    ]);

    // One blank opens the assistant block; the interruption row follows it directly.
    expect(lines.filter((line) => line === "")).toHaveLength(1);
    expect(lines[0]).toBe("");
    expect(lines.at(-1)).toContain("Interrupted");
    expect(lines.at(-2)).toContain("partial answer");
  });

  it("still opens a block for an ordinary user turn", () => {
    const lines = renderReplay([assistantRecord("partial answer"), userRecord("carry on")]);

    expect(lines.filter((line) => line === "")).toHaveLength(2);
  });
});

describe("sessionRecordsToTranscript — replayed reasoning", () => {
  const withThinking: SessionRecord = {
    type: "assistant_message",
    ts: TS,
    content: "the answer",
    thinking: "replayed reasoning",
  };

  it("carries replayed thinking as detail-only by default", () => {
    const entries = sessionRecordsToTranscript([withThinking]);
    expect(entries.map((entry) => entry.kind)).toEqual(["thinking", "assistant"]);
    expect(entries[0]?.detailOnly).toBe(true);

    const prompt = renderReplay([withThinking]).join("\n");
    expect(prompt).not.toContain("replayed reasoning");
    const detailed = renderSettledEntries(
      WIDTH,
      mapTranscriptEntries(sessionRecordsToTranscript([withThinking])),
      "detailed",
    ).join("\n");
    expect(detailed).toContain("replayed reasoning");
  });

  it("keeps thinking first-class when the projection asks for it", () => {
    const entries = sessionRecordsToTranscript([withThinking], { includeThinking: true });
    expect(entries[0]?.kind).toBe("thinking");
    expect(entries[0]?.detailOnly).toBeUndefined();
  });
});
