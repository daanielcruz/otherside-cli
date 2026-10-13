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

describe("sessionRecordsToTranscript — /loop ticks", () => {
  function tickRecord(ts: string, quiet?: { streak: number; since: string }): SessionRecord {
    return {
      type: "attachment",
      ts,
      attachment: {
        type: "loop_tick",
        prompt: "check the deploy",
        ...(quiet ? { quietStreak: quiet.streak, quietSince: quiet.since } : {}),
      },
    };
  }

  it("folds quiet ticks into the tick that follows them, as the live view did", () => {
    const first = "2026-09-25T10:01:00.000Z";
    const entries = sessionRecordsToTranscript([
      userRecord("/loop check the deploy"),
      assistantRecord("loop started"),
      tickRecord(first),
      assistantRecord("nothing new"),
      tickRecord("2026-09-25T10:02:00.000Z", { streak: 1, since: first }),
      assistantRecord("still nothing"),
      tickRecord("2026-09-25T10:03:00.000Z", { streak: 2, since: first }),
      assistantRecord("the deploy finished"),
    ]);

    expect(entries.map((entry) => entry.text)).toEqual([
      "/loop check the deploy",
      "loop started",
      expect.stringMatching(/^Resuming \/loop wakeup \(.+\) · 2 no-op ticks since /),
      "the deploy finished",
    ]);
    expect(entries[2]?.loopTick).toBe(true);
  });

  it("keeps every tick that did not fold", () => {
    const entries = sessionRecordsToTranscript([
      tickRecord("2026-09-25T10:01:00.000Z"),
      assistantRecord("deploy started"),
      tickRecord("2026-09-25T10:02:00.000Z"),
      assistantRecord("deploy finished"),
    ]);
    expect(entries.filter((entry) => entry.loopTick === true)).toHaveLength(2);
    expect(entries).toHaveLength(4);
  });
});
