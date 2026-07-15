import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

export type Bytes = Uint8Array;

export type DeviceKeyPair = { priv: Bytes; pub: Bytes };

export type SessionWrap = { v: 1; n: string; ct: string };

export type EventEnvelope = { v: 1; c: number; n: string; ct: string };

const ENC = new TextEncoder();

const INFO_PAIR_CONFIRM = ENC.encode("otherside/pair-confirm/v2");
const INFO_SESSION_KEY_WRAP = ENC.encode("otherside/session-key-wrap/v1");
const INFO_SESSION_BUNDLE_WRAP = ENC.encode("otherside/session-bundle-wrap/v1");
const INFO_ENV_BROADCAST = ENC.encode("otherside/env-broadcast/v1");
const INFO_DESIGN_CONFIRM = ENC.encode("otherside/design-confirm/v1");
const RATCHET_PREFIX = ENC.encode("otherside/ratchet/v1/");

const KEY_LEN = 32;
const NONCE_LEN = 24;

function uint16BE(n: number): Bytes {
  if (n < 0 || n > 0xffff) throw new Error("uint16 overflow");
  const b = new Uint8Array(2);
  b[0] = (n >>> 8) & 0xff;
  b[1] = n & 0xff;
  return b;
}

function uint32BE(n: number): Bytes {
  if (n < 0 || n > 0xffffffff) throw new Error("uint32 overflow");
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

function concat(...parts: Bytes[]): Bytes {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function hexToBytes(hex: string): Bytes {
  if (hex.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex");
    out[i] = byte;
  }
  return out;
}

export function b64uEncode(b: Bytes): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] as number);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(s: string): Bytes {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Bytes {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function uuidBytes(uuid: string): Bytes {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) throw new Error("invalid uuid");
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid uuid hex");
    b[i] = byte;
  }
  return b;
}

function assertLen(name: string, b: Bytes, n: number): void {
  if (b.length !== n) throw new Error(`${name} must be ${n} bytes, got ${b.length}`);
}

function ctEq(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export function generateDeviceKeyPair(): DeviceKeyPair {
  const priv = x25519.utils.randomSecretKey();
  const pub = x25519.getPublicKey(priv);
  return { priv, pub };
}

export function generateSessionKey(): Bytes {
  return randomBytes(KEY_LEN);
}

export function generatePairNonce(): Bytes {
  return randomBytes(KEY_LEN);
}

export function pairConfirmToken(args: {
  myPriv: Bytes;
  theirPub: Bytes;
  nonce: Bytes;
  cliFingerprint: Bytes;
}): Bytes {
  assertLen("myPriv", args.myPriv, 32);
  assertLen("theirPub", args.theirPub, 32);
  assertLen("nonce", args.nonce, 32);
  const shared = x25519.getSharedSecret(args.myPriv, args.theirPub);
  return hkdf(sha256, shared, args.nonce, concat(INFO_PAIR_CONFIRM, args.cliFingerprint), KEY_LEN);
}

export function verifyPairConfirmToken(args: {
  myPriv: Bytes;
  theirPub: Bytes;
  nonce: Bytes;
  cliFingerprint: Bytes;
  expected: Bytes;
}): boolean {
  const tok = pairConfirmToken({
    myPriv: args.myPriv,
    theirPub: args.theirPub,
    nonce: args.nonce,
    cliFingerprint: args.cliFingerprint,
  });
  return ctEq(tok, args.expected);
}

export function designConfirmToken(args: {
  myPriv: Bytes;
  theirPub: Bytes;
  sessionId: string;
}): Bytes {
  assertLen("myPriv", args.myPriv, 32);
  assertLen("theirPub", args.theirPub, 32);
  const shared = x25519.getSharedSecret(args.myPriv, args.theirPub);
  return hkdf(sha256, shared, uuidBytes(args.sessionId), INFO_DESIGN_CONFIRM, KEY_LEN);
}

export function verifyDesignConfirmToken(args: {
  myPriv: Bytes;
  theirPub: Bytes;
  sessionId: string;
  expected: Bytes;
}): boolean {
  const tok = designConfirmToken({
    myPriv: args.myPriv,
    theirPub: args.theirPub,
    sessionId: args.sessionId,
  });
  return ctEq(tok, args.expected);
}

function sessionWrapKey(args: { shared: Bytes; sessionId: string; senderDeviceId: string }): Bytes {
  const salt = concat(uuidBytes(args.sessionId), uuidBytes(args.senderDeviceId));
  return hkdf(sha256, args.shared, salt, INFO_SESSION_KEY_WRAP, KEY_LEN);
}

export function wrapSessionKey(args: {
  senderPriv: Bytes;
  peerPub: Bytes;
  sessionId: string;
  senderDeviceId: string;
  peerDeviceId: string;
  sessionKey: Bytes;
  nonce?: Bytes;
}): SessionWrap {
  assertLen("senderPriv", args.senderPriv, 32);
  assertLen("peerPub", args.peerPub, 32);
  assertLen("sessionKey", args.sessionKey, KEY_LEN);
  const shared = x25519.getSharedSecret(args.senderPriv, args.peerPub);
  const wrapKey = sessionWrapKey({
    shared,
    sessionId: args.sessionId,
    senderDeviceId: args.senderDeviceId,
  });
  const nonce = args.nonce ?? randomBytes(NONCE_LEN);
  assertLen("nonce", nonce, NONCE_LEN);
  const ad = concat(uuidBytes(args.peerDeviceId), uuidBytes(args.senderDeviceId));
  const ct = xchacha20poly1305(wrapKey, nonce, ad).encrypt(args.sessionKey);
  return { v: 1, n: b64uEncode(nonce), ct: b64uEncode(ct) };
}

export function unwrapSessionKey(args: {
  receiverPriv: Bytes;
  senderPub: Bytes;
  sessionId: string;
  senderDeviceId: string;
  receiverDeviceId: string;
  wrapped: SessionWrap;
}): Bytes {
  if (args.wrapped.v !== 1) throw new Error("unsupported wrap version");
  assertLen("receiverPriv", args.receiverPriv, 32);
  assertLen("senderPub", args.senderPub, 32);
  const shared = x25519.getSharedSecret(args.receiverPriv, args.senderPub);
  const wrapKey = sessionWrapKey({
    shared,
    sessionId: args.sessionId,
    senderDeviceId: args.senderDeviceId,
  });
  const nonce = b64uDecode(args.wrapped.n);
  const ct = b64uDecode(args.wrapped.ct);
  const ad = concat(uuidBytes(args.receiverDeviceId), uuidBytes(args.senderDeviceId));
  return xchacha20poly1305(wrapKey, nonce, ad).decrypt(ct);
}

export function wrapSessionBundle(args: {
  appPriv: Bytes;
  cliPub: Bytes;
  nonce: Bytes;
  cliDeviceId: string;
  appDeviceId: string;
  plaintext: Bytes;
  envelopeNonce?: Bytes;
}): SessionWrap {
  assertLen("appPriv", args.appPriv, 32);
  assertLen("cliPub", args.cliPub, 32);
  assertLen("nonce", args.nonce, 32);
  const shared = x25519.getSharedSecret(args.appPriv, args.cliPub);
  const wrapKey = hkdf(sha256, shared, args.nonce, INFO_SESSION_BUNDLE_WRAP, KEY_LEN);
  const envelopeNonce = args.envelopeNonce ?? randomBytes(NONCE_LEN);
  assertLen("envelopeNonce", envelopeNonce, NONCE_LEN);
  const ad = concat(uuidBytes(args.cliDeviceId), uuidBytes(args.appDeviceId));
  const ct = xchacha20poly1305(wrapKey, envelopeNonce, ad).encrypt(args.plaintext);
  return { v: 1, n: b64uEncode(envelopeNonce), ct: b64uEncode(ct) };
}

export function unwrapSessionBundle(args: {
  cliPriv: Bytes;
  appPub: Bytes;
  nonce: Bytes;
  cliDeviceId: string;
  appDeviceId: string;
  wrapped: SessionWrap;
}): Bytes {
  if (args.wrapped.v !== 1) throw new Error("unsupported wrap version");
  assertLen("cliPriv", args.cliPriv, 32);
  assertLen("appPub", args.appPub, 32);
  assertLen("nonce", args.nonce, 32);
  const shared = x25519.getSharedSecret(args.cliPriv, args.appPub);
  const wrapKey = hkdf(sha256, shared, args.nonce, INFO_SESSION_BUNDLE_WRAP, KEY_LEN);
  const envelopeNonce = b64uDecode(args.wrapped.n);
  const ct = b64uDecode(args.wrapped.ct);
  const ad = concat(uuidBytes(args.cliDeviceId), uuidBytes(args.appDeviceId));
  return xchacha20poly1305(wrapKey, envelopeNonce, ad).decrypt(ct);
}

export function wrapEnvBroadcast(args: {
  senderPriv: Bytes;
  recipientPub: Bytes;
  salt: Bytes;
  senderDeviceId: string;
  recipientDeviceId: string;
  plaintext: Bytes;
  nonce?: Bytes;
}): SessionWrap {
  assertLen("senderPriv", args.senderPriv, 32);
  assertLen("recipientPub", args.recipientPub, 32);
  assertLen("salt", args.salt, 32);
  const shared = x25519.getSharedSecret(args.senderPriv, args.recipientPub);
  const wrapKey = hkdf(sha256, shared, args.salt, INFO_ENV_BROADCAST, KEY_LEN);
  const nonce = args.nonce ?? randomBytes(NONCE_LEN);
  assertLen("nonce", nonce, NONCE_LEN);
  const ad = concat(uuidBytes(args.recipientDeviceId), uuidBytes(args.senderDeviceId));
  const ct = xchacha20poly1305(wrapKey, nonce, ad).encrypt(args.plaintext);
  return { v: 1, n: b64uEncode(nonce), ct: b64uEncode(ct) };
}

export function unwrapEnvBroadcast(args: {
  recipientPriv: Bytes;
  senderPub: Bytes;
  salt: Bytes;
  senderDeviceId: string;
  recipientDeviceId: string;
  wrapped: SessionWrap;
}): Bytes {
  if (args.wrapped.v !== 1) throw new Error("unsupported wrap version");
  assertLen("recipientPriv", args.recipientPriv, 32);
  assertLen("senderPub", args.senderPub, 32);
  assertLen("salt", args.salt, 32);
  const shared = x25519.getSharedSecret(args.recipientPriv, args.senderPub);
  const wrapKey = hkdf(sha256, shared, args.salt, INFO_ENV_BROADCAST, KEY_LEN);
  const nonce = b64uDecode(args.wrapped.n);
  const ct = b64uDecode(args.wrapped.ct);
  const ad = concat(uuidBytes(args.recipientDeviceId), uuidBytes(args.senderDeviceId));
  return xchacha20poly1305(wrapKey, nonce, ad).decrypt(ct);
}

export function deriveRatchetKey(prev: Bytes, counter: number): Bytes {
  assertLen("prev", prev, KEY_LEN);
  if (counter < 0 || !Number.isInteger(counter)) throw new Error("invalid counter");
  const info = concat(RATCHET_PREFIX, uint32BE(counter));
  return hkdf(sha256, prev, new Uint8Array(0), info, KEY_LEN);
}

export function ratchetTo(sessionKey: Bytes, targetCounter: number): Bytes {
  assertLen("sessionKey", sessionKey, KEY_LEN);
  if (targetCounter < 0 || !Number.isInteger(targetCounter)) {
    throw new Error("invalid counter");
  }
  let k = sessionKey;
  for (let i = 1; i <= targetCounter; i++) k = deriveRatchetKey(k, i);
  return k;
}

export function ratchetStep(prev: Bytes, prevCounter: number, targetCounter: number): Bytes {
  assertLen("prev", prev, KEY_LEN);
  if (targetCounter <= prevCounter) throw new Error("ratchet must advance");
  let k = prev;
  for (let i = prevCounter + 1; i <= targetCounter; i++) k = deriveRatchetKey(k, i);
  return k;
}

function buildEventAd(args: {
  sessionId: string;
  eventType: string;
  senderDeviceId: string;
  counter: number;
}): Bytes {
  const evtBytes = ENC.encode(args.eventType);
  if (evtBytes.length === 0) throw new Error("event_type required");
  if (evtBytes.length > 0xffff) throw new Error("event_type too long");
  return concat(
    uuidBytes(args.sessionId),
    uint16BE(evtBytes.length),
    evtBytes,
    uuidBytes(args.senderDeviceId),
    uint32BE(args.counter),
  );
}

export function encryptEvent(args: {
  ratchetKey: Bytes;
  sessionId: string;
  eventType: string;
  senderDeviceId: string;
  counter: number;
  plaintext: Bytes;
  nonce?: Bytes;
}): EventEnvelope {
  assertLen("ratchetKey", args.ratchetKey, KEY_LEN);
  const nonce = args.nonce ?? randomBytes(NONCE_LEN);
  assertLen("nonce", nonce, NONCE_LEN);
  const ad = buildEventAd({
    sessionId: args.sessionId,
    eventType: args.eventType,
    senderDeviceId: args.senderDeviceId,
    counter: args.counter,
  });
  const ct = xchacha20poly1305(args.ratchetKey, nonce, ad).encrypt(args.plaintext);
  return { v: 1, c: args.counter, n: b64uEncode(nonce), ct: b64uEncode(ct) };
}

export function decryptEvent(args: {
  ratchetKey: Bytes;
  sessionId: string;
  eventType: string;
  senderDeviceId: string;
  envelope: EventEnvelope;
}): Bytes {
  if (args.envelope.v !== 1) throw new Error("unsupported envelope version");
  assertLen("ratchetKey", args.ratchetKey, KEY_LEN);
  const nonce = b64uDecode(args.envelope.n);
  const ct = b64uDecode(args.envelope.ct);
  const ad = buildEventAd({
    sessionId: args.sessionId,
    eventType: args.eventType,
    senderDeviceId: args.senderDeviceId,
    counter: args.envelope.c,
  });
  return xchacha20poly1305(args.ratchetKey, nonce, ad).decrypt(ct);
}

export function canonicalPair(a: string, b: string): { deviceA: string; deviceB: string } {
  return a < b ? { deviceA: a, deviceB: b } : { deviceA: b, deviceB: a };
}
