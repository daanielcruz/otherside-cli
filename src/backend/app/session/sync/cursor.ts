import {
  loadSyncedAnchor,
  migrateSyncCursor,
  persistSyncedAnchor,
} from "@/backend/shared/session-crypto.ts";
import type { Session, SessionRecord } from "@/kernel/std/types/session.ts";

/**
 * How much of the record array the companion already holds.
 *
 * Only `anchor` is durable. `skip` counts records that follow it in the array
 * loaded right now and is deliberately not persisted: the transcript reader
 * does not rebuild unnamed records, so a reloaded array does not contain them
 * and a carried-over count would step over real records instead.
 */
export interface SyncCursor {
  /** The last named record delivered, or null when nothing has been. */
  anchor: string | null;
  /** Unnamed records delivered directly after `anchor`, in this array only. */
  skip: number;
}

export const EMPTY_SYNC_CURSOR: SyncCursor = { anchor: null, skip: 0 };

/**
 * The name a record answers to across loads, or null for one that has none.
 *
 * Carrying a uuid and surviving a resume are the same property here: the
 * transcript reader reconstructs exactly the records that were written with
 * one. That makes it the right test for an anchor — a cursor parked on a
 * record that will not come back would find nothing on the next load.
 */
export function anchorUuid(record: SessionRecord | undefined): string | null {
  return typeof record?.uuid === "string" ? record.uuid : null;
}

/**
 * Where the outgoing rail resumes for a cursor.
 *
 * A cursor whose anchor is no longer in the array resumes from the start of
 * what is loaded — not from the start of the conversation, since the array
 * holds the window this session read. The broker keys duplicates on the event
 * counter and a resend mints fresh counters, so those records reach the
 * companion a second time; that is the deliberate cost of never dropping
 * records silently. `skip` applies only when the anchor is found, so a stale
 * count can repeat a record but never step over one.
 */
export function resumeIndexFor(session: Session, cursor: SyncCursor): number {
  if (cursor.anchor === null) return 0;
  // The anchor is the most recently delivered record, so it sits near the end
  // on every call that is not a cold resume.
  for (let i = session.records.length - 1; i >= 0; i--) {
    if (session.records[i]?.uuid === cursor.anchor) {
      return Math.min(i + 1 + cursor.skip, session.records.length);
    }
  }
  return 0;
}

/**
 * The cursor covering every record before `index`.
 *
 * Records with no name cannot anchor, so the anchor falls back to the nearest
 * named record and `skip` measures the distance forward from it. Measuring
 * from the anchor rather than from the start of the array is what keeps the
 * count meaningful while earlier records are collapsed away.
 */
export function cursorThrough(session: Session, index: number, current: SyncCursor): SyncCursor {
  const end = Math.min(index, session.records.length);
  for (let i = end - 1; i >= 0; i--) {
    const uuid = anchorUuid(session.records[i]);
    if (uuid !== null) return { anchor: uuid, skip: end - 1 - i };
  }
  // Nothing before `index` can anchor. Holding the cursor still re-offers
  // those records later; advancing it on a name we do not have would lose them.
  return current;
}

/**
 * The session's cursor, converting a position-addressed one on first use.
 *
 * The conversion runs here because this is the last moment the array still has
 * the shape those positions were written against — see `migrateSyncCursor`,
 * whose precondition this call is what satisfies.
 */
export function adoptSyncCursor(session: Session): SyncCursor {
  // A reduced record set stands for history rather than reproducing it, so a
  // stored position names nothing in it. The conversion is refused there and the
  // legacy field is dropped instead.
  migrateSyncCursor(session.id, (index) => anchorUuid(session.records[index]), {
    positionsResolve: session.recordsArePartial !== true,
  });
  return { anchor: loadSyncedAnchor(session.id), skip: 0 };
}

/** Advance the cursor to cover every record before `index`, persisting its anchor. */
export function commitSyncedThrough(
  session: Session,
  index: number,
  current: SyncCursor,
): SyncCursor {
  const next = cursorThrough(session, index, current);
  if (next.anchor !== current.anchor) persistSyncedAnchor(session.id, next.anchor);
  return next;
}
