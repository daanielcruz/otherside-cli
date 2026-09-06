import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Device } from "@/backend/shared/device.ts";
import {
  claimOutgoingCounters,
  ensureSessionKey,
  hasRemoteDeletionMarker,
  loadSyncedAnchor,
  migrateSyncCursor,
  persistRemoteDeletionMarker,
  type RatchetCacheEntry,
} from "@/backend/shared/session-crypto.ts";
import type { Session } from "@/kernel/std/types/session.ts";
import { anchorUuid, EMPTY_SYNC_CURSOR, resumeIndexFor } from "../cursor.ts";
import { syncOutgoingEvents } from "../rails/durable.ts";

let base: string;
let savedRemoteHome: string | undefined;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "otherside-remote-outbox-test-"));
  savedRemoteHome = process.env.OTHERSIDE_REMOTE_HOME;
  process.env.OTHERSIDE_REMOTE_HOME = base;
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
  if (savedRemoteHome === undefined) {
    delete process.env.OTHERSIDE_REMOTE_HOME;
  } else {
    process.env.OTHERSIDE_REMOTE_HOME = savedRemoteHome;
  }
  rmSync(base, { recursive: true, force: true });
});

// Event AD encodes the session id as a 16-byte UUID, and crypto.ts memoizes
// key files per session id — so every test needs a fresh, real UUID.
function makeSession(recordCount: number): Session {
  const records = Array.from({ length: recordCount }, (_, i) => ({
    type: "user_message" as const,
    // Persisted records are stamped on write; the cursor names them by it.
    uuid: `record-${i}-${crypto.randomUUID()}`,
    content: `message ${i}`,
  }));
  return { id: crypto.randomUUID(), records } as unknown as Session;
}

/** How many records the persisted anchor covers, for assertions in positions. */
function syncedCount(session: Session): number {
  return resumeIndexFor(session, { anchor: loadSyncedAnchor(session.id), skip: 0 });
}

// Bun's fetch type carries a `preconnect` static; Object.assign builds a
// structurally complete stand-in so no cast is needed anywhere.
function installFetch(
  handler: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): void {
  fetchSpy.mockImplementation(Object.assign(handler, { preconnect: () => {} }));
}

interface SentRequests {
  // counters carried by each request, in order; a batch POST contributes one
  // inner array with every row's counter, a single POST contributes one entry
  bodies: number[][];
  counters: number[];
}

function extractCounters(init?: RequestInit): number[] {
  const body = JSON.parse(String(init?.body ?? "{}")) as
    | {
        counter?: number;
        events?: Array<{ counter?: number }>;
      }
    | Array<{ counter?: number }>;
  if (Array.isArray(body)) {
    return body.map((row) => row.counter).filter((c): c is number => typeof c === "number");
  }
  if (Array.isArray(body.events)) {
    return body.events.map((row) => row.counter).filter((c): c is number => typeof c === "number");
  }
  return typeof body.counter === "number" ? [body.counter] : [];
}

function stubFetch(statuses: number[]): SentRequests {
  const sent: SentRequests = { bodies: [], counters: [] };
  let call = 0;
  installFetch(async (_url, init) => {
    const rowCounters = extractCounters(init);
    sent.bodies.push(rowCounters);
    sent.counters.push(...rowCounters);
    const status = statuses[Math.min(call, statuses.length - 1)] ?? 201;
    call += 1;
    // cortex envelope for success; error envelope for failures
    if (status === 201 || status === 200) {
      return new Response(
        JSON.stringify({
          status: "success",
          data: { inserted: rowCounters.length },
          request_id: "t",
        }),
        { status: 200 },
      );
    }
    if (status === 409) {
      return new Response(
        JSON.stringify({
          status: "error",
          error_code: "replay_detected",
          message: "duplicate",
          request_id: "t",
        }),
        { status: 409 },
      );
    }
    if (status === 403) {
      return new Response(
        JSON.stringify({
          status: "error",
          error_code: "forbidden",
          message: "pairing forbidden",
          request_id: "t",
        }),
        { status: 403 },
      );
    }
    if (status === 401) {
      return new Response(
        JSON.stringify({
          status: "error",
          error_code: "unauthorized",
          message: "auth",
          request_id: "t",
        }),
        { status: 401 },
      );
    }
    return new Response(
      JSON.stringify({
        status: "error",
        error_code: "internal",
        message: "error",
        request_id: "t",
      }),
      { status },
    );
  });
  return sent;
}

function stubFetchRejected(code: string, status = 409): void {
  installFetch(
    async () =>
      new Response(
        JSON.stringify({
          status: "error",
          error_code: code,
          message: code,
          request_id: "t",
        }),
        { status },
      ),
  );
}

function syncDeps(session: Session) {
  return {
    device: { id: "11111111-1111-4111-8111-111111111111" } as Device,
    session,
    userId: "user-1",
    accessToken: "token",
    sessionKey: ensureSessionKey(session.id),
    ratchet: new Map<string, RatchetCacheEntry>(),
    fromIndex: 0,
    cursor: EMPTY_SYNC_CURSOR,
  };
}

describe("syncOutgoingEvents delivery semantics", () => {
  it("skips sidechain records and syncs only main-chain events", async () => {
    const session = makeSession(2);
    session.records.splice(
      1,
      0,
      ...([
        { type: "assistant_message", content: "agent turn", isSidechain: true },
        { type: "tool_call", tool_name: "Bash", args: {}, call_id: "side-1", isSidechain: true },
      ] as unknown as Session["records"]),
    );
    const sent = stubFetch([200]);
    const result = await syncOutgoingEvents(syncDeps(session));
    expect(result.idx).toBe(session.records.length);
    expect(sent.counters.length).toBe(2);
  });

  it("does not advance past an event on retryable server errors", async () => {
    const session = makeSession(3);
    stubFetch([500]);
    const result = await syncOutgoingEvents(syncDeps(session));
    expect(result.idx).toBe(0);
    expect(result.retryable).toBe(true);
    expect(result.authStatus).toBeNull();
  });

  it("does not advance past an event when the network throws", async () => {
    const session = makeSession(2);
    installFetch(async () => {
      throw new Error("socket reset");
    });
    const result = await syncOutgoingEvents(syncDeps(session));
    expect(result.idx).toBe(0);
    expect(result.retryable).toBe(true);
  });

  it("treats 409 duplicate as delivered and advances", async () => {
    const session = makeSession(2);
    stubFetch([409]);
    const result = await syncOutgoingEvents(syncDeps(session));
    expect(result.idx).toBe(2);
    expect(result.retryable).toBeUndefined();
    expect(result.authStatus).toBeNull();
  });

  it("halts without advancing on a non-duplicate conflict", async () => {
    const session = makeSession(2);
    stubFetchRejected("conflict");
    const result = await syncOutgoingEvents(syncDeps(session));
    expect(result.idx).toBe(0);
    expect(result.rejected).toBe("conflict");
    expect(result.authStatus).toBeNull();
    expect(syncedCount(session)).toBe(0);
  });

  it("halts a single-record send on a rejected conflict without advancing", async () => {
    const session = makeSession(1);
    stubFetchRejected("conflict");
    const result = await syncOutgoingEvents(syncDeps(session));
    expect(result.idx).toBe(0);
    expect(result.rejected).toBe("conflict");
    expect(syncedCount(session)).toBe(0);
  });

  it("classifies a forbidden event insert as rejected, not auth", async () => {
    const session = makeSession(2);
    stubFetchRejected("forbidden", 403);
    const result = await syncOutgoingEvents(syncDeps(session));
    expect(result.idx).toBe(0);
    expect(result.rejected).toBe("forbidden");
    expect(result.authStatus).toBeNull();
    expect(syncedCount(session)).toBe(0);
  });

  it("classifies an absent session as recoverable rejection", async () => {
    const session = makeSession(2);
    stubFetchRejected("not_found", 404);
    const result = await syncOutgoingEvents(syncDeps(session));
    expect(result.idx).toBe(0);
    expect(result.rejected).toBe("not_found");
    expect(syncedCount(session)).toBe(0);
  });

  it("classifies a manual deletion as terminal rejection", async () => {
    const session = makeSession(2);
    stubFetchRejected("session_deleted", 410);
    const result = await syncOutgoingEvents(syncDeps(session));
    expect(result.idx).toBe(0);
    expect(result.rejected).toBe("session_deleted");
    expect(syncedCount(session)).toBe(0);
  });

  it("keeps treating a plain 403 without an error code as an auth failure", async () => {
    const session = makeSession(1);
    installFetch(async () => new Response("forbidden", { status: 403 }));
    const result = await syncOutgoingEvents(syncDeps(session));
    expect(result.idx).toBe(0);
    expect(result.authStatus).toBe(403);
    expect(result.rejected).toBeUndefined();
  });

  it("halts on auth failure without advancing", async () => {
    const session = makeSession(3);
    stubFetch([401]);
    const result = await syncOutgoingEvents(syncDeps(session));
    expect(result.idx).toBe(0);
    expect(result.authStatus).toBe(401);
  });

  it("halts on auth failure at the unsent event on the serial fallback", async () => {
    const session = makeSession(3);
    // batch 409 -> serial fallback: first row delivered, second rejected
    stubFetch([409, 201, 401]);
    const result = await syncOutgoingEvents(syncDeps(session));
    expect(result.idx).toBe(1);
    expect(result.authStatus).toBe(401);
    expect(syncedCount(session)).toBe(1);
  });

  it("advances through the full backlog on success and persists the cursor", async () => {
    const session = makeSession(3);
    stubFetch([201]);
    const result = await syncOutgoingEvents(syncDeps(session));
    expect(result.idx).toBe(3);
    expect(syncedCount(session)).toBe(3);
  });

  it("reuses the same counter when retrying a failed event", async () => {
    const session = makeSession(1);
    const firstAttempt = stubFetch([500]);
    await syncOutgoingEvents(syncDeps(session));
    const retry = stubFetch([201]);
    const result = await syncOutgoingEvents(syncDeps(session));
    expect(result.idx).toBe(1);
    expect(firstAttempt.counters).toHaveLength(1);
    expect(retry.counters).toHaveLength(1);
    expect(retry.counters[0]).toBe(firstAttempt.counters[0]!);
  });
});

describe("syncOutgoingEvents batching", () => {
  it("sends a backlog of N records as one POST with N rows", async () => {
    const session = makeSession(5);
    const sent = stubFetch([201]);
    const result = await syncOutgoingEvents(syncDeps(session));
    expect(result.idx).toBe(5);
    expect(sent.bodies).toHaveLength(1);
    expect(sent.bodies[0]).toEqual([1, 2, 3, 4, 5]);
    expect(syncedCount(session)).toBe(5);
  });

  it("splits a backlog larger than the batch cap into multiple POSTs", async () => {
    const session = makeSession(30);
    const sent = stubFetch([201]);
    const result = await syncOutgoingEvents(syncDeps(session));
    expect(result.idx).toBe(30);
    expect(sent.bodies).toHaveLength(2);
    expect(sent.bodies[0]).toHaveLength(25);
    expect(sent.bodies[1]).toHaveLength(5);
  });

  it("falls back to serial sends when the batch insert conflicts", async () => {
    const session = makeSession(3);
    const sent = stubFetch([409, 201, 409, 201]);
    const result = await syncOutgoingEvents(syncDeps(session));
    expect(result.idx).toBe(3);
    expect(result.authStatus).toBeNull();
    // one batch POST + three per-record POSTs carrying the same counters
    expect(sent.bodies).toHaveLength(4);
    expect(sent.bodies[0]).toEqual([1, 2, 3]);
    expect(sent.bodies.slice(1)).toEqual([[1], [2], [3]]);
    expect(syncedCount(session)).toBe(3);
  });

  it("reuses the claimed counters when retrying a failed batch", async () => {
    const session = makeSession(4);
    const firstAttempt = stubFetch([500]);
    const first = await syncOutgoingEvents(syncDeps(session));
    expect(first.idx).toBe(0);
    expect(first.retryable).toBe(true);
    const retry = stubFetch([201]);
    const result = await syncOutgoingEvents(syncDeps(session));
    expect(result.idx).toBe(4);
    expect(retry.bodies).toHaveLength(1);
    expect(retry.bodies[0]).toEqual(firstAttempt.bodies[0]!);
  });

  it("reuses batch-claimed counters for records still unsent after a partial serial fallback", async () => {
    const session = makeSession(3);
    // batch 409 -> serial: first row lands, second hits a transient error
    stubFetch([409, 201, 500]);
    const first = await syncOutgoingEvents(syncDeps(session));
    expect(first.idx).toBe(1);
    expect(first.retryable).toBe(true);
    const retry = stubFetch([201]);
    const result = await syncOutgoingEvents({
      ...syncDeps(session),
      fromIndex: first.idx,
      cursor: first.cursor,
    });
    expect(result.idx).toBe(3);
    // the surviving records keep the counters claimed for them originally
    expect(retry.bodies[0]).toEqual([2, 3]);
  });

  it("reuses the claim for a batch led by a record that carries no name", async () => {
    // Queued user input syncs but carries no uuid. When it leads the batch the
    // claim still has to align, or the retry mints fresh counters — and the
    // broker keys duplicates on the counter, so the companion would show the
    // row twice instead of resolving the resend as a replay.
    const session = makeSession(3);
    session.records[0] = {
      type: "injection_queued",
      source: "user",
      text: "queued while a turn ran",
    } as unknown as Session["records"][number];

    const firstAttempt = stubFetch([500]);
    const first = await syncOutgoingEvents(syncDeps(session));
    expect(first.retryable).toBe(true);
    const retry = stubFetch([201]);
    const result = await syncOutgoingEvents(syncDeps(session));

    expect(result.idx).toBe(3);
    expect(retry.bodies[0]).toEqual(firstAttempt.bodies[0]!);
  });

  it("mints fresh counters when no record in the batch can be named", async () => {
    // Two all-unnamed batches are indistinguishable, so matching them on shape
    // would risk reusing counters the broker already accepted — which resolves
    // as a replay and drops the rows. A repeated row is the safer failure.
    const session = makeSession(2);
    session.records = session.records.map(
      (_, i) =>
        ({
          type: "injection_queued",
          source: "user",
          text: `queued ${i}`,
        }) as unknown as Session["records"][number],
    );

    const firstAttempt = stubFetch([500]);
    await syncOutgoingEvents(syncDeps(session));
    const retry = stubFetch([201]);
    await syncOutgoingEvents(syncDeps(session));

    expect(retry.bodies[0]![0]).toBeGreaterThan(firstAttempt.bodies[0]![1]!);
  });
});

describe("sync progress persistence", () => {
  it("returns no anchor for a freshly created key file", () => {
    const session = makeSession(0);
    ensureSessionKey(session.id);
    expect(loadSyncedAnchor(session.id)).toBeNull();
    expect(syncedCount(session)).toBe(0);
  });

  it("persists manual deletion without resetting keys or counters", () => {
    const session = makeSession(0);
    const key = ensureSessionKey(session.id);
    const counters = claimOutgoingCounters(session.id, ["a", "b"]);

    expect(hasRemoteDeletionMarker(session.id)).toBe(false);
    persistRemoteDeletionMarker(session.id);
    expect(hasRemoteDeletionMarker(session.id)).toBe(true);
    expect(ensureSessionKey(session.id)).toEqual(key);
    expect(claimOutgoingCounters(session.id, ["a", "b"])).toEqual(counters);
  });

  it("mints fresh counters for a batch whose lead record carries no name", () => {
    const session = makeSession(0);
    ensureSessionKey(session.id);
    const first = claimOutgoingCounters(session.id, [null, null]);
    const second = claimOutgoingCounters(session.id, [null, null]);
    expect(second[0]).toBeGreaterThan(first[1]!);
  });
});

describe("cursor migration off record positions", () => {
  function writeKeyFile(sessionId: string, data: Record<string, unknown>): void {
    const dir = join(base, "session_keys");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, `${sessionId}.json`),
      JSON.stringify({ key_b64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", ...data }),
      { mode: 0o600 },
    );
  }

  function migrate(session: Session): void {
    migrateSyncCursor(session.id, (i) => anchorUuid(session.records[i]));
  }

  it("leaves a key file that never synced without an anchor", () => {
    const session = makeSession(3);
    writeKeyFile(session.id, { counter: 5 });
    migrate(session);
    expect(loadSyncedAnchor(session.id)).toBeNull();
    expect(syncedCount(session)).toBe(0);
  });

  it("converts a position to the record it named, resending nothing", () => {
    const session = makeSession(6);
    writeKeyFile(session.id, { counter: 5, last_synced_index: 4 });
    migrate(session);
    expect(loadSyncedAnchor(session.id)).toBe(anchorUuid(session.records[3]));
    expect(syncedCount(session)).toBe(4);
  });

  it("still addresses the same record after the array in front of it shrinks", () => {
    const session = makeSession(6);
    writeKeyFile(session.id, { counter: 5, last_synced_index: 4 });
    migrate(session);
    const anchored = session.records[3]!.uuid;

    // The aggregates rework collapses older records; the tail keeps its name.
    session.records.splice(0, 2);
    expect(syncedCount(session)).toBe(2);
    expect(session.records[syncedCount(session) - 1]!.uuid).toBe(anchored);
  });

  it("carries a legacy single-entry claim across, so a retry reuses its counter", () => {
    const session = makeSession(8);
    writeKeyFile(session.id, {
      counter: 7,
      last_synced_index: 4,
      pending_counter: { index: 4, counter: 7 },
    });
    migrate(session);
    const lead = anchorUuid(session.records[4]);
    expect(claimOutgoingCounters(session.id, [lead, null, null])).toEqual([7, 8, 9]);
  });

  it("runs once — a later call cannot re-read a position that is already gone", () => {
    const session = makeSession(6);
    writeKeyFile(session.id, { counter: 5, last_synced_index: 4 });
    migrate(session);
    const anchored = loadSyncedAnchor(session.id);

    session.records.splice(0, 3);
    migrate(session);
    expect(loadSyncedAnchor(session.id)).toBe(anchored);
  });
});
