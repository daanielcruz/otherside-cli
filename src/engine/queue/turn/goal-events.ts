import { appendHookEventRecord, nowIso, type Session } from "@/engine/session/index.ts";
import type { TranscriptEntry, TranscriptWrite } from "@/engine/session/record/types.ts";
import type { TurnNoticeLevel } from "@/kernel/std/types/events.ts";

const GOAL_GLYPHS = {
  check: "✔",
  bulletHollow: "○",
  bullseye: "◎",
} as const;

interface GoalEventDeps {
  session: Session;
  setTranscript: (value: TranscriptWrite) => void;
  turnHadVisibleOutputRef: { current: boolean };
  /** Settles the reply still streaming, so a row lands after the text it follows. */
  settleLiveReply: () => Promise<void>;
}

/**
 * Goal and turn-ending rows: each verdict or notice paints a transcript line and
 * persists its hook event.
 */
export function createGoalEventHandlers(deps: GoalEventDeps): {
  goal_met: (ev: { condition: string; iteration: number }) => Promise<void>;
  goal_not_met: (ev: { condition: string; iteration: number; reason: string }) => Promise<void>;
  goal_paused_bg: (ev: {
    condition: string;
    iteration: number;
    runningBackgroundTasks: number;
  }) => Promise<void>;
  turn_notice: (ev: { text: string; level: TurnNoticeLevel }) => Promise<void>;
  notification_delivered: (ev: { summary: string }) => Promise<void>;
} {
  const { session, setTranscript, turnHadVisibleOutputRef, settleLiveReply } = deps;
  const append = async (entry: TranscriptEntry): Promise<void> => {
    await settleLiveReply();
    setTranscript((t) => [...t, entry]);
  };
  return {
    goal_met: async (ev) => {
      await append({
        id: `goal_met_${session.eventSeq}_${ev.iteration}`,
        kind: "system",
        text: `${GOAL_GLYPHS.check} Goal achieved — ${ev.condition}`,
      });
      await appendHookEventRecord(session, {
        type: "hook_event",
        ts: nowIso(),
        kind: "goal_met",
        payload: { condition: ev.condition, iteration: ev.iteration },
      });
    },
    goal_not_met: async (ev) => {
      turnHadVisibleOutputRef.current = true;
      await append({
        id: `goal_not_met_${session.eventSeq}_${ev.iteration}`,
        kind: "system",
        text: `${GOAL_GLYPHS.bulletHollow} Goal not yet met — ${ev.reason}`,
      });
      await appendHookEventRecord(session, {
        type: "hook_event",
        ts: nowIso(),
        kind: "goal_not_met",
        payload: { condition: ev.condition, iteration: ev.iteration, reason: ev.reason },
      });
    },
    goal_paused_bg: async (ev) => {
      turnHadVisibleOutputRef.current = true;
      const plural = ev.runningBackgroundTasks === 1 ? "task" : "tasks";
      await append({
        id: `goal_paused_bg_${session.eventSeq}_${ev.iteration}`,
        kind: "system",
        text: `${GOAL_GLYPHS.bullseye} Goal paused — waiting on ${ev.runningBackgroundTasks} background ${plural}`,
      });
      await appendHookEventRecord(session, {
        type: "hook_event",
        ts: nowIso(),
        kind: "goal_paused_bg",
        payload: {
          condition: ev.condition,
          iteration: ev.iteration,
          runningBackgroundTasks: ev.runningBackgroundTasks,
        },
      });
    },
    // The notice's own attachment record replays this row after resume.
    turn_notice: async (ev) => {
      turnHadVisibleOutputRef.current = true;
      await append({
        id: `turn_notice_${session.eventSeq}_${Date.now()}`,
        kind: "system",
        text: ev.text,
        level: ev.level,
      });
    },
    // The notification's own attachment record replays this row after resume.
    notification_delivered: async (ev) => {
      await append({
        id: `notice_${session.eventSeq}_${Date.now()}`,
        kind: "task_notice",
        text: ev.summary,
        isError: false,
      });
    },
  };
}
