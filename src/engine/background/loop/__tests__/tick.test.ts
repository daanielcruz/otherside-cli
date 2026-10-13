import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  foldLoopTick,
  type LoopTickRecord,
  loopTickFireText,
  loopTickFolds,
  loopTickNoteBlocks,
  openLoopTick,
  quietStreakBefore,
  readLoopTick,
} from "@/engine/background/loop/tick.ts";
import {
  AGENT_TOOL_REJECTED_RESULT,
  AGENT_TOOL_REJECTED_WITH_FEEDBACK_PREFIX,
  USER_REJECTED_TOOL_RESULT,
  USER_REJECTED_WITH_FEEDBACK_PREFIX,
} from "@/engine/queue/runtime/rejection-text.ts";
import type { SessionRecord } from "@/engine/session/record/index.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import { PERMISSION_DENIED_MESSAGE } from "@/engine/tools/pipeline.ts";

const PROMPT = "check the deploy";
const TICK_AT = "2026-09-25T10:00:00.000Z";

function tick(extra: { quietStreak?: number; quietSince?: string } = {}): LoopTickRecord {
  return {
    type: "attachment",
    ts: TICK_AT,
    attachment: { type: "loop_tick", prompt: PROMPT, ...extra },
  };
}

function todayAt(hours: number, minutes: number): Date {
  const at = new Date();
  at.setHours(hours, minutes, 0, 0);
  return at;
}

function wakeupCall(callId: string, args: Record<string, unknown>): SessionRecord[] {
  return [
    { type: "tool_call", ts: TICK_AT, tool_name: "ScheduleWakeup", call_id: callId, args },
    { type: "tool_result", ts: TICK_AT, call_id: callId, result: "scheduled", is_error: false },
  ];
}

function quietSpan(): SessionRecord[] {
  return [
    { type: "assistant_message", ts: TICK_AT, content: "still nothing" },
    ...wakeupCall("w1", { delaySeconds: 60, reason: "idle", prompt: PROMPT, noop: true }),
  ];
}

describe("quietStreakBefore", () => {
  it("never folds the first tick after the loop starts", () => {
    expect(quietStreakBefore(quietSpan())).toBeNull();
    expect(loopTickFolds(openLoopTick(quietSpan(), PROMPT).attachment)).toBe(false);
  });

  it("starts a streak at the previous tick when that tick reported no change", () => {
    expect(quietStreakBefore([tick(), ...quietSpan()])).toEqual({ streak: 1, since: TICK_AT });
  });

  it("extends a running streak from where it started", () => {
    const since = "2026-09-25T09:00:00.000Z";
    expect(
      quietStreakBefore([tick({ quietStreak: 2, quietSince: since }), ...quietSpan()]),
    ).toEqual({ streak: 3, since });
  });

  it("keeps a tick visible when anything worth seeing happened after it", () => {
    const vetoes: SessionRecord[][] = [
      [{ type: "user_message", ts: TICK_AT, content: "any news?" }],
      [
        {
          type: "user_message",
          ts: TICK_AT,
          content: "<local-command-stdout>ok</local-command-stdout>",
          isMeta: true,
        },
      ],
      [
        {
          type: "attachment",
          ts: TICK_AT,
          attachment: {
            type: "queued_command",
            prompt: "<task-notification/>",
            commandMode: "task-notification",
          },
        },
      ],
      [{ type: "compaction_mark", ts: TICK_AT, summary_ref: "summary" } as SessionRecord],
      [{ type: "tool_result", ts: TICK_AT, call_id: "orphan", result: "x", is_error: false }],
    ];
    for (const veto of vetoes) {
      expect(quietStreakBefore([tick(), ...veto, ...quietSpan()])).toBeNull();
    }
  });

  it("keeps a tick visible when the user refused or interrupted a tool in it", () => {
    const stopped = (result: string): SessionRecord[] => [
      { type: "tool_call", ts: TICK_AT, tool_name: "Bash", call_id: "b1", args: {} },
      { type: "tool_result", ts: TICK_AT, call_id: "b1", result, is_error: true },
    ];
    for (const refusal of [
      PERMISSION_DENIED_MESSAGE,
      USER_REJECTED_TOOL_RESULT,
      `${USER_REJECTED_WITH_FEEDBACK_PREFIX}<directions>`,
      AGENT_TOOL_REJECTED_RESULT,
      `${AGENT_TOOL_REJECTED_WITH_FEEDBACK_PREFIX}<directions>`,
    ]) {
      expect(quietStreakBefore([tick(), ...stopped(refusal), ...quietSpan()])).toBeNull();
    }
    expect(
      quietStreakBefore([tick(), ...stopped("Interrupted by user"), ...quietSpan()]),
    ).toBeNull();
    expect(quietStreakBefore([tick(), ...stopped("exit code 1"), ...quietSpan()])).not.toBeNull();
  });

  it("keeps a tick visible when a cron task fired in or just before its span", () => {
    const cronFire: SessionRecord = {
      type: "attachment",
      ts: TICK_AT,
      attachment: { type: "scheduled_task_fire", prompt: "run the report" },
    };
    expect(quietStreakBefore([tick(), cronFire, ...quietSpan()])).toBeNull();
    expect(quietStreakBefore([cronFire, tick(), ...quietSpan()])).toBeNull();
  });

  it("keeps a tick visible when the conversation was compacted just before it", () => {
    const compaction = { type: "compaction_mark", ts: TICK_AT, summary_ref: "s" } as SessionRecord;
    expect(quietStreakBefore([compaction, tick(), ...quietSpan()])).toBeNull();
    expect(
      quietStreakBefore([compaction, tick(), ...quietSpan(), tick(), ...quietSpan()]),
    ).not.toBeNull();
  });

  it("follows the model's last report of the tick", () => {
    const reported = (noop: unknown) =>
      wakeupCall("w2", { delaySeconds: 60, reason: "idle", prompt: PROMPT, noop });
    expect(quietStreakBefore([tick(), ...reported(false)])).toBeNull();
    expect(quietStreakBefore([tick(), ...reported(undefined)])).toBeNull();
    expect(quietStreakBefore([tick(), ...quietSpan(), ...reported(false)])).toBeNull();
    expect(quietStreakBefore([tick(), ...reported(false), ...quietSpan()])).not.toBeNull();
  });

  it("ignores records a subagent wrote", () => {
    const subagentPrompt: SessionRecord = {
      type: "user_message",
      ts: TICK_AT,
      content: "subagent task",
      isSidechain: true,
    };
    expect(quietStreakBefore([tick(), subagentPrompt, ...quietSpan()])).not.toBeNull();
  });
});

describe("loop tick texts", () => {
  const priorLocale = process.env.LC_ALL;
  beforeAll(() => {
    process.env.LC_ALL = "en_US.UTF-8";
  });
  afterAll(() => {
    if (priorLocale === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = priorLocale;
  });

  it("tells the model how many wakeups it no longer sees", () => {
    expect(loopTickNoteBlocks(tick().attachment)).toEqual([]);
    expect(loopTickNoteBlocks(tick({ quietStreak: 1, quietSince: TICK_AT }).attachment)).toEqual([
      { type: "text", text: "[1 prior /loop wakeup found nothing actionable; loop is healthy.]" },
    ]);
    expect(loopTickNoteBlocks(tick({ quietStreak: 3, quietSince: TICK_AT }).attachment)).toEqual([
      { type: "text", text: "[3 prior /loop wakeups found nothing actionable; loop is healthy.]" },
    ]);
  });

  it("names the wakeup time and the streak it stands for", () => {
    const firedAt = todayAt(13, 58);
    const since = todayAt(13, 40).toISOString();
    expect(loopTickFireText(tick().attachment, firedAt)).toMatch(
      /^Resuming \/loop wakeup \(1:58\sPM\)$/,
    );
    expect(
      loopTickFireText(tick({ quietStreak: 1, quietSince: since }).attachment, firedAt),
    ).toMatch(/^Resuming \/loop wakeup \(1:58\sPM\) · 1 no-op tick since 1:40\sPM$/);
    expect(
      loopTickFireText(tick({ quietStreak: 4, quietSince: since }).attachment, firedAt),
    ).toMatch(/ · 4 no-op ticks since /);
  });

  it("reads back only a well-formed tick", () => {
    expect(readLoopTick({ type: "loop_tick", prompt: PROMPT })).toEqual({
      type: "loop_tick",
      prompt: PROMPT,
    });
    expect(readLoopTick({ type: "loop_tick" })).toBeNull();
    expect(readLoopTick({ type: "queued_command", prompt: PROMPT })).toBeNull();
    expect(readLoopTick({ type: "loop_tick", prompt: PROMPT, quietStreak: 2 })).toEqual({
      type: "loop_tick",
      prompt: PROMPT,
    });
  });
});

describe("foldLoopTick", () => {
  const line = (id: string): TranscriptEntry => ({ id, kind: "system", text: id, loopTick: true });
  const said = (id: string): TranscriptEntry => ({ id, kind: "assistant", text: id });

  it("appends a tick that does not fold", () => {
    const entries = [said("a"), line("t1"), said("b")];
    expect(foldLoopTick(entries, line("t2"), false)).toEqual([...entries, line("t2")]);
  });

  it("replaces the previous tick and what it produced", () => {
    const entries = [said("loop started"), line("t1"), said("nothing new")];
    expect(foldLoopTick(entries, line("t2"), true)).toEqual([said("loop started"), line("t2")]);
  });

  it("appends when there is no earlier tick line to fold into", () => {
    expect(foldLoopTick([said("a")], line("t2"), true)).toEqual([said("a"), line("t2")]);
  });
});
