import type { DesignSpawn } from "@/design/types.ts";

/**
 * Pairing-link + reachability state tracked alongside a spawn. Lives in a side
 * map (not on DesignSpawn) so the relay can seed it before the spawn is
 * registered and the overlay can read it without widening the spawn type.
 */
interface SpawnLinkMeta {
  /** ISO timestamp the current design_open_token expires at. */
  expiresAt: string | null;
  /** True once the auto-remint cap is exhausted — the link is dead for good. */
  linkExpired: boolean;
  /** Failure reason while outbound sends keep failing, null when reachable. */
  unreachable: string | null;
}

const bySession = new Map<string, DesignSpawn>();
const byId = new Map<string, DesignSpawn>();
const metaById = new Map<string, SpawnLinkMeta>();
const listeners = new Set<() => void>();

function metaFor(spawnId: string): SpawnLinkMeta {
  let meta = metaById.get(spawnId);
  if (!meta) {
    meta = { expiresAt: null, linkExpired: false, unreachable: null };
    metaById.set(spawnId, meta);
  }
  return meta;
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isActive(): boolean {
  return byId.size > 0;
}

export function register(spawn: DesignSpawn): void {
  bySession.set(spawn.sessionId, spawn);
  byId.set(spawn.id, spawn);
  notify();
}

export function unregister(spawnId: string): void {
  metaById.delete(spawnId);
  const spawn = byId.get(spawnId);
  if (!spawn) return;
  byId.delete(spawnId);
  if (bySession.get(spawn.sessionId)?.id === spawnId) {
    bySession.delete(spawn.sessionId);
  }
  notify();
}

export function markAttached(spawnId: string): void {
  const spawn = byId.get(spawnId);
  if (spawn && !spawn.attached) {
    spawn.attached = true;
    notify();
  }
}

/**
 * Record a freshly minted pairing link. Updates the live spawn URL (if the
 * spawn is already registered) so the overlay swaps it in place, and restarts
 * the expiry countdown. Safe to call before register() — the meta survives.
 */
export function setSpawnLink(spawnId: string, url: string, expiresAt: string): void {
  const meta = metaFor(spawnId);
  meta.expiresAt = expiresAt;
  meta.linkExpired = false;
  const spawn = byId.get(spawnId);
  if (spawn) spawn.url = url;
  notify();
}

/** The auto-remint cap was exhausted — the pairing link is permanently dead. */
export function markLinkExpired(spawnId: string): void {
  const meta = metaFor(spawnId);
  if (meta.linkExpired) return;
  meta.linkExpired = true;
  meta.expiresAt = null;
  notify();
}

/** Flag the session as unreachable (outbound sends keep failing). */
export function markUnreachable(spawnId: string, reason: string): void {
  const meta = metaFor(spawnId);
  if (meta.unreachable === reason) return;
  meta.unreachable = reason;
  notify();
}

/** Clear the unreachable flag after a successful outbound send. */
export function markReachable(spawnId: string): void {
  const meta = metaById.get(spawnId);
  if (!meta || meta.unreachable === null) return;
  meta.unreachable = null;
  notify();
}

export function getLinkExpiresAt(spawnId: string): string | null {
  return metaById.get(spawnId)?.expiresAt ?? null;
}

export function isLinkExpired(spawnId: string): boolean {
  return metaById.get(spawnId)?.linkExpired ?? false;
}

export function getUnreachableReason(spawnId: string): string | null {
  return metaById.get(spawnId)?.unreachable ?? null;
}

export function getBySession(sessionId: string): DesignSpawn | undefined {
  return bySession.get(sessionId);
}

export function list(): DesignSpawn[] {
  return Array.from(byId.values());
}

export async function stopAll(): Promise<void> {
  const spawns = list();
  bySession.clear();
  byId.clear();
  metaById.clear();
  notify();
  await Promise.all(spawns.map((s) => s.stop().catch(() => {})));
}
