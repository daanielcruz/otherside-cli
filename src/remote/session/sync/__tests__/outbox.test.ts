import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@/kernel/std/types/session.ts";
import type { Device } from "@/remote/devices/device.ts";
import {
  claimOutgoingCounters,
  ensureSessionKey,
  loadSyncedIndex,
  type RatchetCacheEntry,
} from "../crypto.ts";
import { syncOutgoingEvents } from "../rails/cdc.ts";

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
    content: `message ${i}`,
  }));
  return { id: crypto.randomUUID(), records } as unknown as Session;
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
          error_code: "conflict",
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
          message: "rls",
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
          error_code: code === "23505" ? "conflict" : code === "42501" ? "forbidden" : code,
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
  };
}

describe("syncOutgoingEvents delivery semantics", () => {
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

  it("halts without advancing on a 409 that is not a unique violation", async () => {
    const session = makeSession(2);
    // e.g. 23503: the sessions row is gone (purged after an account switch),
    // so the insert FK-fails — it must never pass as a delivered duplicate
    stubFetchRejected("23503");
    const result = await syncOutgoingEvents(syncDeps(session));
    expect(result.idx).toBe(0);
    expect(result.rejected).toBe("23503");
    expect(result.authStatus).toBeNull();
    expect(loadSyncedIndex(session.id)).toBe(0);
  });

  it("halts a single-record send on a rejected conflict without advancing", async () => {
    const session = makeSession(1);
    stubFetchRejected("23503");
    const result = await syncOutgoingEvents(syncDeps(session));
    expect(result.idx).toBe(0);
    expect(result.rejected).toBe("23503");
    expect(loadSyncedIndex(session.id)).toBe(0);
  });

  it("classifies an RLS-refused 403 insert as rejected, not auth", async () => {
    const session = makeSession(2);
    // With RLS the missing/foreign sessions row fails the insert with-check
    // as 403 + 42501 before the FK ever fires (live-probed against prod).
    stubFetchRejected("42501", 403);
    const result = await syncOutgoingEvents(syncDeps(session));
    expect(result.idx).toBe(0);
    expect(result.rejected).toBe("42501");
    expect(result.authStatus).toBeNull();
    expect(loadSyncedIndex(session.id)).toBe(0);
  });

  it("keeps treating a plain 403 without an RLS code as an auth failure", async () => {
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
    expect(loadSyncedIndex(session.id)).toBe(1);
  });

  it("advances through the full backlog on success and persists the cursor", async () => {
    const session = makeSession(3);
    stubFetch([201]);
    const result = await syncOutgoingEvents(syncDeps(session));
    expect(result.idx).toBe(3);
    expect(loadSyncedIndex(session.id)).toBe(3);
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
    expect(loadSyncedIndex(session.id)).toBe(5);
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
    expect(loadSyncedIndex(session.id)).toBe(3);
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
    const result = await syncOutgoingEvents({ ...syncDeps(session), fromIndex: first.idx });
    expect(result.idx).toBe(3);
    // the surviving records keep the counters claimed for them originally
    expect(retry.bodies[0]).toEqual([2, 3]);
  });
});

describe("sync progress persistence", () => {
  it("returns 0 for a freshly created key file", () => {
    const session = makeSession(0);
    ensureSessionKey(session.id);
    expect(loadSyncedIndex(session.id)).toBe(0);
  });

  it("returns null for a legacy key file without sync tracking", () => {
    const sessionId = crypto.randomUUID();
    const dir = join(base, "session_keys");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, `${sessionId}.json`),
      JSON.stringify({ key_b64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", counter: 5 }),
      { mode: 0o600 },
    );
    expect(loadSyncedIndex(sessionId)).toBeNull();
  });

  it("reuses a legacy single-entry pending claim inside a batch claim", () => {
    const sessionId = crypto.randomUUID();
    const dir = join(base, "session_keys");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, `${sessionId}.json`),
      JSON.stringify({
        key_b64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        counter: 7,
        last_synced_index: 4,
        pending_counter: { index: 4, counter: 7 },
      }),
      { mode: 0o600 },
    );
    expect(claimOutgoingCounters(sessionId, 4, 3)).toEqual([7, 8, 9]);
  });
});
