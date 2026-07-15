import type { BackgroundController } from "@/kernel/std/types/events.ts";

interface ControllerRegistration {
  controller: BackgroundController;
  token: symbol;
}

const map = new Map<string, ControllerRegistration>();

export function register(callId: string, controller: BackgroundController): () => void {
  const token = Symbol(callId);
  map.set(callId, { controller, token });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = map.get(callId);
    if (current?.token === token) map.delete(callId);
  };
}

export function get(callId: string): BackgroundController | undefined {
  return map.get(callId)?.controller;
}

export function unregister(callId: string, expectedController?: BackgroundController): void {
  const current = map.get(callId);
  if (current === undefined) return;
  if (expectedController !== undefined && current.controller !== expectedController) return;
  map.delete(callId);
}

export function callIds(): string[] {
  return Array.from(map.keys());
}

export function _resetForTests(): void {
  map.clear();
}
