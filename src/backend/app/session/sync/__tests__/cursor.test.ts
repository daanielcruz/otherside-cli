import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSyncedAnchor, migrateSyncCursor } from "@/backend/shared/session-crypto.ts";
import type { Session, SessionRecord } from "@/kernel/std/types/session.ts";
import {
  adoptSyncCursor,
  anchorUuid,
  commitSyncedThrough,
  cursorThrough,
  EMPTY_SYNC_CURSOR,
  resumeIndexFor,
  type SyncCursor,
} from "../cursor.ts";

let base: string;
let savedRemoteHome: string | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "otherside-sync-cursor-test-"));
  savedRemoteHome = process.env.OTHERSIDE_REMOTE_HOME;
  process.env.OTHERSIDE_REMOTE_HOME = base;
});

afterEach(() => {
  if (savedRemoteHome === undefined) delete process.env.OTHERSIDE_REMOTE_HOME;
  else process.env.OTHERSIDE_REMOTE_HOME = savedRemoteHome;
  rmSync(base, { recursive: true, force: true });
});

/**
 * `named` records carry a uuid and come back on resume; `unnamed` ones stand in
 * for queued input, which syncs but which the transcript reader never rebuilds.
 */
function sessionOf(...shape: Array<"named" | "unnamed">): Session {
  const records: SessionRecord[] = shape.map((kind, i) =>
    kind === "named"
      ? { type: "user_message", uuid: `u${i}`, content: `m${i}` }
      : { type: "injection_queued", source: "user", text: `q${i}` },
  );
  return { id: crypto.randomUUID(), records } as unknown as Session;
}

function at(anchor: string | null, skip = 0): SyncCursor {
  return { anchor, skip };
}

describe("anchorUuid", () => {
  it("names only records the transcript reader brings back", () => {
    const session = sessionOf("named", "unnamed");
    expect(anchorUuid(session.records[0])).toBe("u0");
    expect(anchorUuid(session.records[1])).toBeNull();
    expect(anchorUuid(undefined)).toBeNull();
  });
});

describe("resumeIndexFor", () => {
  it("resumes just after the anchored record", () => {
    expect(resumeIndexFor(sessionOf("named", "named", "named"), at("u1"))).toBe(2);
  });

  it("resumes from the start of the loaded window when nothing is anchored", () => {
    expect(resumeIndexFor(sessionOf("named", "named"), EMPTY_SYNC_CURSOR)).toBe(0);
  });

  it("resumes from the start of the loaded window when the anchor is gone", () => {
    // Records the companion already holds are offered again rather than skipped:
    // the broker keys duplicates on the counter, so a resend repeats rather than
    // deduplicates — chosen over dropping records the phone never received.
    expect(resumeIndexFor(sessionOf("named", "named"), at("u9"))).toBe(0);
  });

  it("addresses the same record after the array in front of it shrinks", () => {
    const session = sessionOf("named", "named", "named", "named");
    expect(resumeIndexFor(session, at("u2"))).toBe(3);
    session.records.splice(0, 2);
    expect(resumeIndexFor(session, at("u2"))).toBe(1);
  });

  it("carries past unnamed records delivered after the anchor", () => {
    const session = sessionOf("named", "unnamed", "unnamed");
    expect(resumeIndexFor(session, at("u0", 2))).toBe(3);
  });

  it("ignores the count when the anchor is gone, so it can never step over a record", () => {
    expect(resumeIndexFor(sessionOf("named", "named"), at("u9", 5))).toBe(0);
  });

  it("never points past the records it was given", () => {
    const session = sessionOf("named", "named");
    expect(resumeIndexFor(session, at("u1", 40))).toBe(2);
  });
});

describe("cursorThrough", () => {
  it("anchors on the last named record before the index", () => {
    expect(cursorThrough(sessionOf("named", "named"), 2, EMPTY_SYNC_CURSOR)).toEqual(at("u1"));
  });

  it("counts unnamed records forward from the anchor", () => {
    const session = sessionOf("named", "unnamed", "unnamed");
    expect(cursorThrough(session, 3, EMPTY_SYNC_CURSOR)).toEqual(at("u0", 2));
  });

  it("holds the cursor still when nothing before the index can anchor", () => {
    const session = sessionOf("unnamed", "unnamed");
    expect(cursorThrough(session, 2, at("earlier"))).toEqual(at("earlier"));
  });

  it("clamps an index past the end to the records it has", () => {
    expect(cursorThrough(sessionOf("named", "named"), 99, EMPTY_SYNC_CURSOR)).toEqual(at("u1"));
  });
});

describe("commitSyncedThrough", () => {
  it("persists the record naming everything delivered", () => {
    const session = sessionOf("named", "named", "named");
    expect(commitSyncedThrough(session, 2, EMPTY_SYNC_CURSOR)).toEqual(at("u1"));
    expect(loadSyncedAnchor(session.id)).toBe("u1");
  });

  it("does not re-offer queued rows already delivered after the anchor", () => {
    // The anchor cannot name a queued row, so without the count the next push
    // would resume at it and send it again with a fresh counter.
    const session = sessionOf("named", "unnamed", "unnamed");
    const cursor = commitSyncedThrough(session, 3, EMPTY_SYNC_CURSOR);
    expect(resumeIndexFor(session, cursor)).toBe(3);
  });

  it("persists only the anchor, so a reload does not step over rebuilt records", () => {
    const session = sessionOf("named", "unnamed", "unnamed");
    commitSyncedThrough(session, 3, EMPTY_SYNC_CURSOR);
    // The reader does not rebuild queued rows, so the reloaded array is shorter.
    const reloaded = sessionOf("named", "named");
    Object.assign(reloaded, { id: session.id });
    expect(resumeIndexFor(reloaded, adoptSyncCursor(reloaded))).toBe(1);
  });

  it("writes nothing when the anchor has not moved", () => {
    const session = sessionOf("named");
    commitSyncedThrough(session, 1, EMPTY_SYNC_CURSOR);
    expect(commitSyncedThrough(session, 1, at("u0"))).toEqual(at("u0"));
    expect(loadSyncedAnchor(session.id)).toBe("u0");
  });
});

describe("migrateSyncCursor preconditions", () => {
  function writeLegacyKeyFile(sessionId: string, lastSyncedIndex: number): void {
    const dir = join(base, "session_keys");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, `${sessionId}.json`),
      JSON.stringify({
        key_b64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        counter: 5,
        last_synced_index: lastSyncedIndex,
      }),
      { mode: 0o600 },
    );
  }

  it("converts against the array it is handed, and nothing else identifies it", () => {
    // The contract this pins is the caller's, not the function's: a position
    // carries no evidence of the array it was written against, so the same file
    // converted against a shorter array names a different record — silently.
    // Adopting at session start, while the records are replayed from the
    // transcript, is what satisfies it. Once records are built from aggregates
    // the legacy field must be dropped instead of converted.
    const full = sessionOf("named", "named", "named", "named", "named", "named");
    writeLegacyKeyFile(full.id, 4);
    expect(adoptSyncCursor(full)).toEqual(at("u3"));

    const shrunk = sessionOf("named", "named", "named", "named", "named", "named");
    writeLegacyKeyFile(shrunk.id, 4);
    shrunk.records.splice(0, 2);
    // Position 3 of the shrunken array is a different record from position 3 of
    // the full one; the conversion cannot tell, which is why it must not run here.
    expect(adoptSyncCursor(shrunk)).toEqual(at("u5"));
  });

  it("refuses the conversion when the records stand for history instead of holding it", () => {
    // An aggregate-backed set has no position the stored cursor could name. The
    // legacy field is dropped unconverted, which resends the session — duplicate
    // rows on the companion, rather than an anchor naming the wrong record that
    // resolves cleanly while costing records outright.
    const session = sessionOf("named", "named", "named", "named", "named", "named");
    writeLegacyKeyFile(session.id, 4);
    session.recordsArePartial = true;

    expect(adoptSyncCursor(session)).toEqual({ anchor: null, skip: 0 });
    // Dropped rather than parked: nothing is left for a later adopt to misread.
    session.recordsArePartial = false;
    expect(adoptSyncCursor(session)).toEqual({ anchor: null, skip: 0 });
  });

  it("runs once — a later call cannot re-read a position that is already gone", () => {
    const session = sessionOf("named", "named", "named", "named", "named", "named");
    writeLegacyKeyFile(session.id, 4);
    const adopted = adoptSyncCursor(session);

    session.records.splice(0, 3);
    migrateSyncCursor(session.id, (i) => anchorUuid(session.records[i]));
    expect(loadSyncedAnchor(session.id)).toBe(adopted.anchor);
  });
});
