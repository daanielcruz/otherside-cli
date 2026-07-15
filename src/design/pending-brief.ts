const pending = new Map<string, string>();

export function setPendingBrief(sessionId: string, brief: string): void {
  pending.set(sessionId, brief);
}

export function takePendingBrief(sessionId: string): string {
  const brief = pending.get(sessionId);
  pending.delete(sessionId);
  return brief ?? "";
}
