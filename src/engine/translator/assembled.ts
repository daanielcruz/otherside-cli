import type { ComposedHarness } from "@/harness/composer/injections.ts";
import type { ProviderToolDeclaration } from "./types.ts";

export interface AssembledTurnSnapshot {
  harness: ComposedHarness;
  tools: ProviderToolDeclaration[];
}

const lastBySession = new Map<string, AssembledTurnSnapshot>();

export function setAssembledTurn(sessionId: string, snapshot: AssembledTurnSnapshot): void {
  lastBySession.set(sessionId, snapshot);
}

export function getAssembledTurn(sessionId: string): AssembledTurnSnapshot | undefined {
  return lastBySession.get(sessionId);
}

export function clearAssembledTurn(sessionId: string): void {
  lastBySession.delete(sessionId);
}
