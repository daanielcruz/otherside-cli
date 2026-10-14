import {
  type AttachmentRecord,
  appendRecord,
  nowIso,
  type Session,
  type TurnNoticeAttachment,
} from "@/engine/session/index.ts";
import type { AgentEvent, TurnNoticeLevel } from "@/kernel/std/types/events.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";

/** Records a line about how the turn ended, for the transcript now and after resume. */
export function turnNotice(session: Session, text: string, level: TurnNoticeLevel): AgentEvent {
  const record: AttachmentRecord = {
    type: "attachment",
    ts: nowIso(),
    attachment: { type: "turn_notice", text, level },
  };
  appendRecord(session, record).catch(() => {});
  return { kind: "turn_notice", text, level };
}

export function readTurnNotice(attachment: unknown): TurnNoticeAttachment | null {
  if (!isRecord(attachment) || attachment.type !== "turn_notice") return null;
  if (typeof attachment.text !== "string") return null;
  return {
    type: "turn_notice",
    text: attachment.text,
    level: attachment.level === "warning" ? "warning" : "notice",
  };
}
