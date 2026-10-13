import type { DrainedQueuedMessage } from "@/kernel/std/types/events.ts";

interface DesignTurn {
  controller: AbortController;
  /** A steer is only accepted while a design fork is running to drain it. */
  steerable: boolean;
}

const turns = new Map<string, DesignTurn>();
const steerQueues = new Map<string, string[]>();

export function registerDesignTurn(designId: string, controller: AbortController): void {
  const existing = turns.get(designId);
  if (existing) existing.controller.abort("superseded");
  turns.set(designId, { controller, steerable: true });
  steerQueues.delete(designId);
}

export function isDesignTurnActive(designId: string): boolean {
  return turns.has(designId);
}

export function ownsDesignTurn(designId: string, controller: AbortController): boolean {
  return turns.get(designId)?.controller === controller;
}

export function setDesignTurnSteerable(
  designId: string,
  controller: AbortController,
  steerable: boolean,
): void {
  const turn = turns.get(designId);
  if (turn?.controller !== controller) return;
  turn.steerable = steerable;
  if (!steerable) steerQueues.delete(designId);
}

export function unregisterDesignTurn(designId: string, controller: AbortController): void {
  if (ownsDesignTurn(designId, controller)) {
    turns.delete(designId);
    steerQueues.delete(designId);
  }
}

/** Abort the running turn; its handler still owns the per-design state until it unregisters. */
export function cancelDesignTurn(designId: string): boolean {
  const turn = turns.get(designId);
  if (!turn) return false;
  turn.steerable = false;
  steerQueues.delete(designId);
  turn.controller.abort("cancelled");
  return true;
}

export function steerDesignTurn(designId: string, text: string): boolean {
  if (!turns.get(designId)?.steerable) return false;
  let queue = steerQueues.get(designId);
  if (!queue) {
    queue = [];
    steerQueues.set(designId, queue);
  }
  queue.push(text);
  return true;
}

export function drainDesignSteers(designId: string): string[] {
  const queue = steerQueues.get(designId);
  if (!queue) return [];
  steerQueues.delete(designId);
  return queue;
}

export function drainDesignSteerMessages(designId: string): DrainedQueuedMessage[] {
  return drainDesignSteers(designId).map((text) => ({
    text,
    blocks: [{ type: "text", text }],
  }));
}
