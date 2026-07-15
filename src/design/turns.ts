const turns = new Map<string, AbortController>();
const steerQueues = new Map<string, string[]>();

export function registerDesignTurn(
  designId: string,
  controller: AbortController,
  owner?: unknown,
): void {
  const existing = turns.get(designId);
  if (existing) existing.abort("superseded");
  turns.set(designId, controller);
  steerQueues.delete(designId);
}

export function isDesignTurnActive(designId: string): boolean {
  return turns.has(designId);
}

export function unregisterDesignTurn(designId: string, controller: AbortController): void {
  if (turns.get(designId) === controller) {
    turns.delete(designId);
    steerQueues.delete(designId);
  }
}

export function cancelDesignTurn(designId: string): boolean {
  const controller = turns.get(designId);
  if (!controller) return false;
  controller.abort("cancelled");
  turns.delete(designId);
  steerQueues.delete(designId);
  return true;
}

export function steerDesignTurn(designId: string, text: string): boolean {
  if (!turns.has(designId)) return false;
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
