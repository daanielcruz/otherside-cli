import {
  type AttachmentRecord,
  nowIso,
  type ScheduledTaskFireAttachment,
} from "@/engine/session/record/index.ts";
import { formatClockTime } from "@/kernel/std/text/clock-time.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";

export type ScheduledTaskFireRecord = AttachmentRecord & {
  attachment: ScheduledTaskFireAttachment;
};

export function readScheduledTaskFire(attachment: unknown): ScheduledTaskFireAttachment | null {
  if (!isRecord(attachment) || attachment.type !== "scheduled_task_fire") return null;
  if (typeof attachment.prompt !== "string") return null;
  return { type: "scheduled_task_fire", prompt: attachment.prompt };
}

export function scheduledTaskFireRecord(prompt: string): ScheduledTaskFireRecord {
  return { type: "attachment", ts: nowIso(), attachment: { type: "scheduled_task_fire", prompt } };
}

export function scheduledTaskFireText(firedAt: Date): string {
  return `Running scheduled task (${formatClockTime(firedAt)})`;
}
