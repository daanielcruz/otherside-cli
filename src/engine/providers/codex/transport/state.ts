import { uuidv7 } from "@/kernel/std/id.ts";

export type CodexTransport = "ws" | "http";

export interface CodexSessionState {
  conversationId: string;
  threadId: string;
  windowGeneration: number;
  transport: CodexTransport;
  fallbackReason: string | null;
  encryptedReasoningRejected: boolean;
  prewarmed?: boolean;
  wsStreamFailures?: number;
}

const STATE = new Map<string, CodexSessionState>();

export function getSessionState(sessionId: string): CodexSessionState {
  let s = STATE.get(sessionId);
  if (!s) {
    s = {
      conversationId: sessionId,
      threadId: uuidv7(),
      windowGeneration: 0,
      transport: "ws",
      fallbackReason: null,
      encryptedReasoningRejected: false,
    };
    STATE.set(sessionId, s);
  }
  return s;
}

export function forceHttpFallback(sessionId: string, reason: string): boolean {
  const s = getSessionState(sessionId);
  if (s.transport === "http") return false;
  s.transport = "http";
  s.fallbackReason = reason;
  return true;
}

export function getTransport(sessionId: string): CodexTransport {
  return STATE.get(sessionId)?.transport ?? "ws";
}

export function advanceWindow(sessionId: string): number {
  const state = getSessionState(sessionId);
  state.windowGeneration += 1;
  return state.windowGeneration;
}

/**
 * Records that the endpoint rejected a replayed reasoning `encrypted_content`
 * blob for this session. The blob is bound to the reasoning chain/credential
 * that produced it, so a provider detour (e.g. anthropic → codex) invalidates
 * it. Returns true the first time so the caller retries once without the blobs;
 * false if already recorded, so a still-failing turn does not retry forever.
 */
export function markEncryptedReasoningRejected(sessionId: string): boolean {
  const s = getSessionState(sessionId);
  if (s.encryptedReasoningRejected) return false;
  s.encryptedReasoningRejected = true;
  return true;
}

export function isEncryptedReasoningRejected(sessionId: string): boolean {
  return STATE.get(sessionId)?.encryptedReasoningRejected ?? false;
}

export function clearSessionState(sessionId: string): void {
  STATE.delete(sessionId);
}

export function snapshotForTest(sessionId: string): CodexSessionState | undefined {
  return STATE.get(sessionId);
}

export function incrementWsStreamFailures(sessionId: string): number {
  const s = getSessionState(sessionId);
  s.wsStreamFailures = (s.wsStreamFailures ?? 0) + 1;
  return s.wsStreamFailures;
}

export function resetWsStreamFailures(sessionId: string): void {
  const s = getSessionState(sessionId);
  s.wsStreamFailures = 0;
}
