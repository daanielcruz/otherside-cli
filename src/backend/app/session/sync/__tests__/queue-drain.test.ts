import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Device } from "@/backend/shared/device.ts";
import { decryptEvent, type EventEnvelope } from "@/backend/shared/e2ee.ts";
import {
  claimOutgoingCounters,
  ensureSessionKey,
  type RatchetCacheEntry,
  ratchetKeyFor,
  sendEncryptedEvent,
} from "@/backend/shared/session-crypto.ts";
import type { DrainedQueuedMessage } from "@/kernel/std/types/events.ts";
import type { Session } from "@/kernel/std/types/session.ts";
import { clearActiveEmitters, setActivePushEmitter } from "../events.ts";
import { emitQueuedInputDrained } from "../queue-drain.ts";

const DEC = new TextDecoder();
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";

let base: string;
let savedRemoteHome: string | undefined;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "otherside-remote-drain-test-"));
  savedRemoteHome = process.env.OTHERSIDE_REMOTE_HOME;
  process.env.OTHERSIDE_REMOTE_HOME = base;
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  clearActiveEmitters();
  fetchSpy.mockRestore();
  if (savedRemoteHome === undefined) {
    delete process.env.OTHERSIDE_REMOTE_HOME;
  } else {
    process.env.OTHERSIDE_REMOTE_HOME = savedRemoteHome;
  }
  rmSync(base, { recursive: true, force: true });
});

// Bun's fetch type carries a `preconnect` static; Object.assign builds a
// structurally complete stand-in so no cast is needed anywhere.
function installFetch(
  handler: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): void {
  fetchSpy.mockImplementation(Object.assign(handler, { preconnect: () => {} }));
}

interface SentRow {
  url: string;
  type?: string;
  counter?: number;
  payload?: EventEnvelope;
  sender_device_id?: string;
}

function stubFetch(): SentRow[] {
  const sent: SentRow[] = [];
  installFetch(async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      sender_device_id?: string;
      events?: Array<{
        type?: string;
        payload?: EventEnvelope;
        counter?: number;
      }>;
    };
    const ev = body.events?.[0];
    const row: SentRow = { url: String(url) };
    if (ev?.type !== undefined) row.type = ev.type;
    if (ev?.payload !== undefined) row.payload = ev.payload;
    if (ev?.counter !== undefined) row.counter = ev.counter;
    if (body.sender_device_id !== undefined) row.sender_device_id = body.sender_device_id;
    sent.push(row);
    return new Response(
      JSON.stringify({ status: "success", data: { inserted: 1 }, request_id: "t" }),
      { status: 200 },
    );
  });
  return sent;
}

// Mirrors the push-emitter wiring in start.ts: a direct encrypted send that
// mints its counter at call time. The returned array collects the in-flight
// sends so the test can await them (emitPushEvent is fire-and-forget).
function installPushEmitter(session: Session): Promise<void>[] {
  const device = { id: DEVICE_ID } as Device;
  const sessionKey = ensureSessionKey(session.id);
  const ratchet = new Map<string, RatchetCacheEntry>();
  const inFlight: Promise<void>[] = [];
  setActivePushEmitter((eventType, plaintext) => {
    const send = sendEncryptedEvent({
      device,
      session,
      userId: "user-1",
      accessToken: "token",
      sessionKey,
      ratchet,
      eventType,
      plaintext,
    }).then(() => {});
    inFlight.push(send);
    return send;
  });
  return inFlight;
}

function makeSession(): Session {
  return { id: crypto.randomUUID(), records: [] } as unknown as Session;
}

function drained(text: string, remotePayload?: unknown): DrainedQueuedMessage {
  return { text, blocks: [], ...(remotePayload !== undefined ? { remotePayload } : {}) };
}

function decryptRow(session: Session, row: SentRow): Record<string, unknown> {
  const sessionKey = ensureSessionKey(session.id);
  const ratchetKey = ratchetKeyFor(
    new Map<string, RatchetCacheEntry>(),
    sessionKey,
    DEVICE_ID,
    row.counter ?? 0,
  );
  const plaintext = decryptEvent({
    ratchetKey,
    sessionId: session.id,
    eventType: row.type ?? "",
    senderDeviceId: DEVICE_ID,
    envelope: row.payload as EventEnvelope,
  });
  return JSON.parse(DEC.decode(plaintext)) as Record<string, unknown>;
}

describe("emitQueuedInputDrained", () => {
  it("sends one decryptable session event per drained message", async () => {
    const session = makeSession();
    const sent = stubFetch();
    const inFlight = installPushEmitter(session);

    emitQueuedInputDrained([
      drained("first message", { queue_id: "q-123" }),
      drained("second message"),
    ]);
    await Promise.all(inFlight);

    expect(sent).toHaveLength(2);
    for (const row of sent) {
      expect(row.url.includes("/v1/sessions/") && row.url.includes("/events")).toBe(true);
      expect(row.type).toBe("queued_input_drained");
      expect(row.sender_device_id).toBe(DEVICE_ID);
    }
    // Counters mint synchronously in call order, so they stay monotonic.
    expect(sent[0]?.counter).toBe(1);
    expect(sent[1]?.counter).toBe(2);
    expect(decryptRow(session, sent[0]!)).toEqual({
      text: "first message",
      queue_id: "q-123",
    });
    expect(decryptRow(session, sent[1]!)).toEqual({ text: "second message" });
  });

  it("carries the queue id under any of the app's identity keys", async () => {
    const session = makeSession();
    const sent = stubFetch();
    const inFlight = installPushEmitter(session);

    emitQueuedInputDrained([
      drained("by camel", { queueId: "q-camel" }),
      drained("by id", { id: "q-plain" }),
      drained("non-string id ignored", { id: 42 }),
    ]);
    await Promise.all(inFlight);

    expect(sent).toHaveLength(3);
    expect(decryptRow(session, sent[0]!)).toEqual({ text: "by camel", queue_id: "q-camel" });
    expect(decryptRow(session, sent[1]!)).toEqual({ text: "by id", queue_id: "q-plain" });
    expect(decryptRow(session, sent[2]!)).toEqual({ text: "non-string id ignored" });
  });

  it("mints counters after a pending claimed range, never inside it", async () => {
    const session = makeSession();
    const sent = stubFetch();
    const inFlight = installPushEmitter(session);

    // The outbox pre-claims counters for a batch it has not delivered yet.
    const claimed = claimOutgoingCounters(session.id, 0, 3);
    expect(claimed).toEqual([1, 2, 3]);

    emitQueuedInputDrained([drained("interleaved drain")]);
    await Promise.all(inFlight);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.counter).toBe(4);
  });

  it("does nothing when no sync session is active", async () => {
    const sent = stubFetch();
    emitQueuedInputDrained([drained("orphan")]);
    await Bun.sleep(0);
    expect(sent).toHaveLength(0);
  });
});
