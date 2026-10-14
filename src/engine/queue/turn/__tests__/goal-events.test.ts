import { describe, expect, it } from "bun:test";
import { createGoalEventHandlers } from "@/engine/queue/turn/goal-events.ts";
import type { Session } from "@/engine/session/index.ts";
import type { TranscriptEntry, TranscriptWrite } from "@/engine/session/record/types.ts";

describe("goal and turn-ending rows", () => {
  it("land after the reply they follow, once it has settled", async () => {
    let transcript: readonly TranscriptEntry[] = [];
    const setTranscript = (value: TranscriptWrite): void => {
      transcript = typeof value === "function" ? value(transcript) : value;
    };
    const handlers = createGoalEventHandlers({
      session: { id: "session-1", eventSeq: 1, pushHookEvent: () => {} } as never as Session,
      setTranscript,
      turnHadVisibleOutputRef: { current: false },
      settleLiveReply: async () => {
        await Promise.resolve();
        setTranscript((t) => [...t, { id: "a_1", kind: "assistant", text: "The last paragraph." }]);
      },
    });

    await handlers.goal_not_met({ condition: "tests pass", iteration: 1, reason: "two failing" });
    await handlers.turn_notice({ text: "Goal paused · …", level: "notice" });

    expect(transcript.map((entry) => entry.kind)).toEqual([
      "assistant",
      "system",
      "assistant",
      "system",
    ]);
    expect(transcript[1]?.text).toContain("Goal not yet met");
  });
});
