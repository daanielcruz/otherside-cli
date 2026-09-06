import { appendHookEventRecord, nowIso, type Session } from "@/engine/session/index.ts";
import type { TranscriptEntry, TranscriptWrite } from "@/engine/session/record/types.ts";

const GOAL_GLYPHS = {
  check: "✔",
  bulletHollow: "○",
  bullseye: "◎",
} as const;

interface GoalEventDeps {
  session: Session;
  setTranscript: (value: TranscriptWrite) => void;
  turnHadVisibleOutputRef: { current: boolean };
}

/** Goal lifecycle rows: each verdict paints a transcript line and persists its hook event. */
export function createGoalEventHandlers(deps: GoalEventDeps): {
  goal_met: (ev: { condition: string; iteration: number }) => Promise<void>;
  goal_not_met: (ev: { condition: string; iteration: number; reason: string }) => Promise<void>;
  goal_paused_bg: (ev: {
    condition: string;
    iteration: number;
    runningBackgroundTasks: number;
  }) => Promise<void>;
} {
  const { session, setTranscript, turnHadVisibleOutputRef } = deps;
  const append = (entry: TranscriptEntry): void => {
    setTranscript((t) => [...t, entry]);
  };
  return {
    goal_met: async (ev) => {
      append({
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
      append({
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
      append({
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
  };
}
