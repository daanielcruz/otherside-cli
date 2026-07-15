import {
  type AttachmentRecord,
  type ForeignAttachment,
  isCompactionBoundary,
  type SessionRecord,
} from "@/engine/session/record/index.ts";
import { isRecord } from "@/kernel/std/value-guards.ts";

const TURNS_BETWEEN_MAINTENANCE = 10;

type LastMarker = "none" | "enter" | "exit";
type UltracodeReminder =
  | { kind: "none" }
  | { kind: "enter"; reminderType: "full" | "sparse" }
  | { kind: "exit" };

interface ReminderResult {
  reminder: UltracodeReminder;
  enterRecord: AttachmentRecord | null;
  exitRecord: AttachmentRecord | null;
}

function isForeignWithType(a: unknown): a is ForeignAttachment {
  return isRecord(a) && typeof a.type === "string";
}

function isUltracodeEnterRecord(r: SessionRecord): boolean {
  if (r.type !== "attachment") return false;
  if (!isForeignWithType(r.attachment)) return false;
  return r.attachment.type === "ultra_effort_enter";
}

function isUltracodeExitRecord(r: SessionRecord): boolean {
  if (r.type !== "attachment") return false;
  if (!isForeignWithType(r.attachment)) return false;
  return r.attachment.type === "ultra_effort_exit";
}

// A genuine conversational turn, not a synthetic echo. Local commands persist
// three user_message records per invocation (caveat / command-name / stdout) and
// interrupt echoes also land as user_message records; all of those carry
// isMeta, so counting only non-meta records keeps the maintenance cadence
// pinned to real typed prompts. Tool results live in separate records here,
// so a user_message record never carries tool_result content.
function isHumanUserMessage(r: SessionRecord): boolean {
  return r.type === "user_message" && r.isMeta !== true;
}

function derivedState(records: SessionRecord[]): {
  lastMarker: LastMarker;
  humanTurns: number;
} {
  let lastMarker: LastMarker = "none";
  let humanTurns = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (!r) continue;
    // Markers behind the latest compaction boundary are out of context: the
    // scan mirrors what the model can still see, so the full enter reminder
    // re-fires right after a compaction erases the previous one.
    if (r.type === "compaction_mark" && isCompactionBoundary(r)) break;
    if (isUltracodeEnterRecord(r)) {
      lastMarker = "enter";
      break;
    }
    if (isUltracodeExitRecord(r)) {
      lastMarker = "exit";
      break;
    }
    if (isHumanUserMessage(r)) humanTurns++;
  }
  return { lastMarker, humanTurns };
}

function makeEnterAttachment(reminderType: "full" | "sparse"): AttachmentRecord {
  const attachment: ForeignAttachment = {
    type: "ultra_effort_enter",
    reminderType,
  };
  return { type: "attachment", ts: new Date().toISOString(), attachment };
}

function makeExitAttachment(): AttachmentRecord {
  const attachment: ForeignAttachment = { type: "ultra_effort_exit" };
  return { type: "attachment", ts: new Date().toISOString(), attachment };
}

export function nextUltracodeReminder(records: SessionRecord[], active: boolean): ReminderResult {
  const { lastMarker, humanTurns } = derivedState(records);
  if (active) {
    if (lastMarker !== "enter") {
      return {
        reminder: { kind: "enter", reminderType: "full" },
        enterRecord: makeEnterAttachment("full"),
        exitRecord: null,
      };
    }
    if (humanTurns >= TURNS_BETWEEN_MAINTENANCE) {
      return {
        reminder: { kind: "enter", reminderType: "sparse" },
        enterRecord: makeEnterAttachment("sparse"),
        exitRecord: null,
      };
    }
    return { reminder: { kind: "none" }, enterRecord: null, exitRecord: null };
  }
  if (lastMarker === "enter") {
    return {
      reminder: { kind: "exit" },
      enterRecord: null,
      exitRecord: makeExitAttachment(),
    };
  }
  return { reminder: { kind: "none" }, enterRecord: null, exitRecord: null };
}

export const ULTRACODE_ENTER_FULL =
  "Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. Use the Workflow tool on every substantive task; token cost is not a constraint. See the Workflow tool's **Ultracode** section and quality patterns. Solo only on conversational/trivial turns.";
export const ULTRACODE_ENTER_SPARSE =
  "Ultracode is still on — use the Workflow tool; see its Ultracode section.";
export const ULTRACODE_EXIT =
  "Ultracode is off — the Workflow tool's standard opt-in rule applies again.";
export const ULTRACODE_KEYWORD_REQUEST =
  'The user included the keyword "ultracode", opting this turn into multi-agent orchestration — use the Workflow tool to fulfill the request.';
