import { describe, expect, test } from "bun:test";
import {
  decryptEvent,
  designConfirmToken,
  encryptEvent,
  generateDeviceKeyPair,
  generateSessionKey,
  verifyDesignConfirmToken,
} from "@/backend/shared/e2ee.ts";
import { type RatchetCacheEntry, ratchetKeyFor } from "@/backend/shared/session-crypto.ts";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

function seal(args: {
  sessionId: string;
  sessionKey: Uint8Array;
  senderId: string;
  counter: number;
  plaintext: string;
}) {
  const ratchet = new Map<string, RatchetCacheEntry>();
  const key = ratchetKeyFor(ratchet, args.sessionKey, args.senderId, args.counter);
  return encryptEvent({
    ratchetKey: key,
    sessionId: args.sessionId,
    eventType: "design_delta",
    senderDeviceId: args.senderId,
    counter: args.counter,
    plaintext: ENC.encode(args.plaintext),
  });
}

function open(args: {
  sessionId: string;
  sessionKey: Uint8Array;
  senderId: string;
  eventType?: string;
  envelope: { v: 1; c: number; n: string; ct: string };
}): string {
  const ratchet = new Map<string, RatchetCacheEntry>();
  const key = ratchetKeyFor(ratchet, args.sessionKey, args.senderId, args.envelope.c);
  return DEC.decode(
    decryptEvent({
      ratchetKey: key,
      sessionId: args.sessionId,
      eventType: args.eventType ?? "design_delta",
      senderDeviceId: args.senderId,
      envelope: args.envelope,
    }),
  );
}

describe("design relay wire crypto", () => {
  const sessionId = crypto.randomUUID();
  const webId = crypto.randomUUID();
  const frame = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "design.open", params: {} });

  test("a frame round-trips from web sender to cli receiver", () => {
    const sessionKey = generateSessionKey();
    const envelope = seal({ sessionId, sessionKey, senderId: webId, counter: 1, plaintext: frame });
    expect(open({ sessionId, sessionKey, senderId: webId, envelope })).toBe(frame);
  });

  test("the AAD binds the event type — a mismatched type fails to open", () => {
    const sessionKey = generateSessionKey();
    const envelope = seal({ sessionId, sessionKey, senderId: webId, counter: 2, plaintext: frame });
    expect(() =>
      open({ sessionId, sessionKey, senderId: webId, eventType: "design_attach", envelope }),
    ).toThrow();
  });

  test("the AAD binds the sender — a mismatched sender id fails to open", () => {
    const sessionKey = generateSessionKey();
    const envelope = seal({ sessionId, sessionKey, senderId: webId, counter: 3, plaintext: frame });
    expect(() =>
      open({ sessionId, sessionKey, senderId: crypto.randomUUID(), envelope }),
    ).toThrow();
  });

  test("a wrong session key cannot open the frame", () => {
    const sessionKey = generateSessionKey();
    const envelope = seal({ sessionId, sessionKey, senderId: webId, counter: 4, plaintext: frame });
    expect(() =>
      open({ sessionId, sessionKey: generateSessionKey(), senderId: webId, envelope }),
    ).toThrow();
  });

  test("the ratchet advances — different counters derive distinct keys", () => {
    const sessionKey = generateSessionKey();
    const ratchet = new Map<string, RatchetCacheEntry>();
    const k1 = ratchetKeyFor(ratchet, sessionKey, webId, 1);
    const k2 = ratchetKeyFor(new Map<string, RatchetCacheEntry>(), sessionKey, webId, 2);
    expect(DEC.decode(k1)).not.toBe(DEC.decode(k2));
  });
});

describe("design channel-auth confirm token", () => {
  const sessionId = crypto.randomUUID();

  test("cli and web derive the same token from their ECDH (verify passes)", () => {
    const cli = generateDeviceKeyPair();
    const web = generateDeviceKeyPair();
    const webToken = designConfirmToken({ myPriv: web.priv, theirPub: cli.pub, sessionId });
    const ok = verifyDesignConfirmToken({
      myPriv: cli.priv,
      theirPub: web.pub,
      sessionId,
      expected: webToken,
    });
    expect(ok).toBe(true);
  });

  test("a substituted peer key fails verification (broker MITM)", () => {
    const cli = generateDeviceKeyPair();
    const web = generateDeviceKeyPair();
    const attacker = generateDeviceKeyPair();
    const webToken = designConfirmToken({ myPriv: web.priv, theirPub: cli.pub, sessionId });
    const ok = verifyDesignConfirmToken({
      myPriv: cli.priv,
      theirPub: attacker.pub,
      sessionId,
      expected: webToken,
    });
    expect(ok).toBe(false);
  });

  test("the token is bound to the session hash", () => {
    const cli = generateDeviceKeyPair();
    const web = generateDeviceKeyPair();
    const webToken = designConfirmToken({ myPriv: web.priv, theirPub: cli.pub, sessionId });
    const ok = verifyDesignConfirmToken({
      myPriv: cli.priv,
      theirPub: web.pub,
      sessionId: crypto.randomUUID(),
      expected: webToken,
    });
    expect(ok).toBe(false);
  });
});
