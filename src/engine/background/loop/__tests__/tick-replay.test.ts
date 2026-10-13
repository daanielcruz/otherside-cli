import { beforeEach, describe, expect, it } from "bun:test";
import { loopTickNoteBlocks, openLoopTick } from "@/engine/background/loop/tick.ts";
import { emitQueue } from "@/engine/queue/emit.ts";
import type { SessionRecord } from "@/engine/session/record/index.ts";
import { sessionRecordsToMessages } from "@/engine/session/transcript/to-messages.ts";

const PROMPT = "check the deploy";

const quietTick: SessionRecord[] = [
  { type: "user_message", ts: "2026-09-25T10:00:00.000Z", content: `/loop ${PROMPT}` },
  {
    type: "attachment",
    ts: "2026-09-25T10:01:00.000Z",
    attachment: { type: "loop_tick", prompt: PROMPT },
  },
  { type: "assistant_message", ts: "2026-09-25T10:01:05.000Z", content: "nothing new" },
  {
    type: "tool_call",
    ts: "2026-09-25T10:01:06.000Z",
    tool_name: "ScheduleWakeup",
    call_id: "w1",
    args: { delaySeconds: 60, reason: "idle", prompt: PROMPT, noop: true },
  },
  {
    type: "tool_result",
    ts: "2026-09-25T10:01:06.000Z",
    call_id: "w1",
    result: "scheduled",
    is_error: false,
  },
  { type: "assistant_message", ts: "2026-09-25T10:01:08.000Z", content: "Next tick in 60s." },
];

beforeEach(() => {
  emitQueue._resetForTests();
});

describe("a /loop tick on resume", () => {
  it("rebuilds the user turn exactly as the live wakeup sent it", () => {
    emitQueue.emit({
      class: "idle_prompt",
      target: "both",
      payload: { kind: "user_interrupt_message", text: PROMPT, scheduledFire: "loop" },
      autoTurn: true,
    });
    const drain = emitQueue.drainForBoundary("turn_start");
    expect(drain.scheduledFires).toEqual([{ kind: "loop", prompt: PROMPT }]);

    const tick = openLoopTick(quietTick, PROMPT);
    const live = [...drain.llmBlocks, ...loopTickNoteBlocks(tick.attachment)];
    const rebuilt = sessionRecordsToMessages([...quietTick, tick]).at(-1);

    expect(rebuilt?.role).toBe("user");
    expect(rebuilt?.content).toEqual(live);
    expect(live).toHaveLength(2);
  });

  it("marks only scheduled prompts in the drain, each with its kind", () => {
    emitQueue.emit({
      class: "idle_prompt",
      target: "both",
      payload: { kind: "user_interrupt_message", text: "not scheduled" },
      autoTurn: true,
    });
    expect(emitQueue.drainForBoundary("turn_start").scheduledFires).toBeUndefined();

    emitQueue.emit({
      class: "idle_prompt",
      target: "both",
      payload: { kind: "user_interrupt_message", text: "run the report", scheduledFire: "task" },
      autoTurn: true,
    });
    expect(emitQueue.drainForBoundary("turn_start").scheduledFires).toEqual([
      { kind: "task", prompt: "run the report" },
    ]);
  });
});
