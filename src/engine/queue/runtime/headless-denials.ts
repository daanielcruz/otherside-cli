// Headless (`--print`) tool-permission denials, keyed by session id.
//
// In headless mode a tool that would raise an interactive prompt is auto-denied
// (there is no UI to answer it — see `resolvePermission`). Each denial is
// recorded here so the print result envelope can surface it as
// `permission_denials`, then drained once when the run finishes.

export interface HeadlessDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
}

const denialsBySession = new Map<string, HeadlessDenial[]>();

export function recordHeadlessDenial(sessionId: string, denial: HeadlessDenial): void {
  const existing = denialsBySession.get(sessionId);
  if (existing) existing.push(denial);
  else denialsBySession.set(sessionId, [denial]);
}

export function takeHeadlessDenials(sessionId: string): HeadlessDenial[] {
  const denials = denialsBySession.get(sessionId) ?? [];
  denialsBySession.delete(sessionId);
  return denials;
}
