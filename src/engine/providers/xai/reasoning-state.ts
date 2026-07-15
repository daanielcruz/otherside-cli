// Per-session guard: once the chat proxy rejects a replayed encrypted-reasoning
// blob (its chain was broken by a provider switch), we stop echoing encrypted
// reasoning for the rest of that session and rebuild the request without it.
const suppressed = new Set<string>();

export function markEncryptedReasoningRejected(sessionId: string): boolean {
  if (suppressed.has(sessionId)) return false;
  suppressed.add(sessionId);
  return true;
}

export function isEncryptedReasoningRejected(sessionId: string): boolean {
  return suppressed.has(sessionId);
}
