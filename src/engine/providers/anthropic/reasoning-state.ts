// Per-session guard: once the API rejects a replayed thinking block (its
// signature no longer matches the request that carries it — e.g. history that
// crossed a provider or credential switch), we stop replaying thinking blocks
// for the rest of that session and rebuild the request without them.
const suppressed = new Set<string>();

export function markThinkingReplayRejected(sessionId: string): boolean {
  if (suppressed.has(sessionId)) return false;
  suppressed.add(sessionId);
  return true;
}

export function isThinkingReplayRejected(sessionId: string): boolean {
  return suppressed.has(sessionId);
}
