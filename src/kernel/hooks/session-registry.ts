import type { HookEntry } from "@/kernel/std/types/hook-entry.ts";
import type { HookEvent } from "./events.ts";

export interface SessionHookEntry {
  entry: HookEntry;
  via: string;
}

const registry = new Map<string, Map<HookEvent, SessionHookEntry[]>>();

export function addSessionHook(sessionId: string, event: HookEvent, entry: SessionHookEntry): void {
  const perSession = registry.get(sessionId) ?? new Map();
  const list = perSession.get(event) ?? [];
  list.push(entry);
  perSession.set(event, list);
  registry.set(sessionId, perSession);
}

export function removeSessionHooksWhere(
  sessionId: string,
  event: HookEvent,
  predicate: (entry: SessionHookEntry) => boolean,
): void {
  const perSession = registry.get(sessionId);
  if (!perSession) return;
  const list = perSession.get(event);
  if (!list) return;
  const filtered = list.filter((e) => !predicate(e));
  if (filtered.length === 0) perSession.delete(event);
  else perSession.set(event, filtered);
}

export function listSessionHooks(sessionId: string, event: HookEvent): SessionHookEntry[] {
  return registry.get(sessionId)?.get(event) ?? [];
}

export function listAllSessionHooks(sessionId: string): Map<HookEvent, SessionHookEntry[]> {
  return registry.get(sessionId) ?? new Map();
}

export function clearSessionHooks(sessionId: string): void {
  registry.delete(sessionId);
}

export function _resetSessionHookRegistryForTesting(): void {
  registry.clear();
}
