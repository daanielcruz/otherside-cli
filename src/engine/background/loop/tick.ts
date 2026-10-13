import { isInterruptedToolResult } from "@/engine/queue/runtime/interruption-text.ts";
import { isUserRejection } from "@/engine/queue/runtime/rejection-text.ts";
import {
  type AttachmentRecord,
  isCompactionBoundary,
  type LoopTickAttachment,
  nowIso,
  type SessionRecord,
  type Timestamp,
} from "@/engine/session/record/index.ts";
import type { TranscriptEntry } from "@/engine/session/record/types.ts";
import { PERMISSION_DENIED_MESSAGE } from "@/engine/tools/pipeline.ts";
import ScheduleWakeupSchema from "@/harness/tools/ScheduleWakeup/tool.json" with { type: "json" };
import { formatClockTime } from "@/kernel/std/text/clock-time.ts";
import { pluralize } from "@/kernel/std/text/pluralize.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";

export type LoopTickRecord = AttachmentRecord & { attachment: LoopTickAttachment };

interface QuietStreak {
  streak: number;
  since: Timestamp;
}

export function readLoopTick(attachment: unknown): LoopTickAttachment | null {
  if (!isRecord(attachment) || attachment.type !== "loop_tick") return null;
  if (typeof attachment.prompt !== "string") return null;
  const { quietStreak, quietSince } = attachment;
  return {
    type: "loop_tick",
    prompt: attachment.prompt,
    ...(typeof quietStreak === "number" && typeof quietSince === "string"
      ? { quietStreak, quietSince }
      : {}),
  };
}

function isSidechainRecord(record: SessionRecord): boolean {
  return "isSidechain" in record && record.isSidechain === true;
}

/** A cron task firing or a compaction: either breaks a run of quiet ticks. */
function breaksQuietRun(record: SessionRecord): boolean {
  if (record.type === "compaction_mark") return isCompactionBoundary(record);
  return record.type === "attachment" && record.attachment.type === "scheduled_task_fire";
}

/** A tool call a rule or the user refused, or the user interrupted: the tick did not run as the model chose. */
function userStoppedTool(record: SessionRecord): boolean {
  if (record.type !== "tool_result" || !record.is_error || typeof record.result !== "string") {
    return false;
  }
  return (
    record.result.startsWith(PERMISSION_DENIED_MESSAGE) ||
    isUserRejection(record.result) ||
    isInterruptedToolResult(record.result)
  );
}

/**
 * The quiet streak the previous tick extends, or null when its span must stay
 * visible: the user spoke, ran a command, or refused or interrupted a tool; a
 * background result or a cron task arrived; the conversation was compacted,
 * there or just before that tick; a tool pair was split; or the model did not
 * report the tick as having changed nothing.
 */
export function quietStreakBefore(records: readonly SessionRecord[]): QuietStreak | null {
  let anchorIndex = -1;
  let anchor: LoopTickAttachment | null = null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record || record.type !== "attachment" || isSidechainRecord(record)) continue;
    anchor = readLoopTick(record.attachment);
    if (anchor !== null) {
      anchorIndex = index;
      break;
    }
  }
  const anchorRecord = records[anchorIndex];
  if (anchor === null || anchorRecord === undefined) return null;
  for (let index = anchorIndex - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record || isSidechainRecord(record)) continue;
    if (record.type === "attachment" && readLoopTick(record.attachment) !== null) break;
    if (breaksQuietRun(record)) return null;
  }

  const calls = new Set<string>();
  let reportedNothing = false;
  for (const record of records.slice(anchorIndex + 1)) {
    if (isSidechainRecord(record)) continue;
    if (record.type === "user_message" || breaksQuietRun(record) || userStoppedTool(record)) {
      return null;
    }
    if (record.type === "attachment" && record.attachment.type === "queued_command") return null;
    if (record.type === "tool_call") {
      calls.add(record.call_id);
      if (record.tool_name === ScheduleWakeupSchema.name) {
        reportedNothing = isRecord(record.args) && record.args.noop === true;
      }
    }
    if (record.type === "tool_result" && !calls.has(record.call_id)) return null;
  }
  if (!reportedNothing) return null;
  return {
    streak: (anchor.quietStreak ?? 0) + 1,
    since: anchor.quietSince ?? anchorRecord.ts,
  };
}

export function openLoopTick(records: readonly SessionRecord[], prompt: string): LoopTickRecord {
  const quiet = quietStreakBefore(records);
  return {
    type: "attachment",
    ts: nowIso(),
    attachment: {
      type: "loop_tick",
      prompt,
      ...(quiet !== null ? { quietStreak: quiet.streak, quietSince: quiet.since } : {}),
    },
  };
}

export function loopTickFolds(tick: LoopTickAttachment): boolean {
  return tick.quietStreak !== undefined;
}

/** What the model reads after the wakeup prompt when the ticks before it are hidden. */
export function loopTickNoteBlocks(tick: LoopTickAttachment): ContentBlock[] {
  if (tick.quietStreak === undefined) return [];
  const streak = tick.quietStreak;
  return [
    {
      type: "text",
      text: `[${streak} prior /loop ${pluralize(streak, "wakeup")} found nothing actionable; loop is healthy.]`,
    },
  ];
}

/** The user turn a tick opens, as the model received it. */
export function loopTickUserBlocks(tick: LoopTickAttachment): ContentBlock[] {
  return [{ type: "text", text: tick.prompt }, ...loopTickNoteBlocks(tick)];
}

export function loopTickFireText(tick: LoopTickAttachment, firedAt: Date): string {
  const fired = `Resuming /loop wakeup (${formatClockTime(firedAt)})`;
  if (tick.quietStreak === undefined || tick.quietSince === undefined) return fired;
  const streak = tick.quietStreak;
  const since = formatClockTime(new Date(tick.quietSince));
  return `${fired} · ${streak} no-op ${pluralize(streak, "tick")} since ${since}`;
}

/**
 * Adds a tick's line to the transcript. A folding tick replaces the previous
 * tick's line and everything that tick produced.
 */
export function foldLoopTick(
  entries: readonly TranscriptEntry[],
  line: TranscriptEntry,
  folds: boolean,
): TranscriptEntry[] {
  const previous = folds ? entries.findLastIndex((entry) => entry.loopTick === true) : -1;
  return previous === -1 ? [...entries, line] : [...entries.slice(0, previous), line];
}
