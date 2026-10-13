import type { ProviderId } from "@/kernel/std/types/provider-ids.ts";

// Per-session, per-provider guard: once a provider rejects a replayed reasoning
// artifact — its signature no longer verifies against the request that carries
// it — we stop replaying that provider's reasoning for the rest of the session
// and rebuild every later request without it. A signature stops verifying when
// history crosses a provider, model, or credential switch, and also when the
// surrounding context it was bound to is rewritten (compaction, or turns from
// another route appended after it).
//
// The guard is keyed per provider so a rejection on one route never suppresses
// reasoning on another route the same session later switches to.
const suppressed = new Set<string>();

function guardKey(sessionId: string, provider: ProviderId): string {
  return `${provider}:${sessionId}`;
}

/**
 * Latch the guard. True only on the first rejection, so exactly one turn spends
 * a retry on it and a still-failing turn falls through to a normal failure.
 */
export function markReasoningReplayRejected(sessionId: string, provider: ProviderId): boolean {
  const key = guardKey(sessionId, provider);
  if (suppressed.has(key)) return false;
  suppressed.add(key);
  return true;
}

export function isReasoningReplayRejected(sessionId: string, provider: ProviderId): boolean {
  return suppressed.has(guardKey(sessionId, provider));
}
