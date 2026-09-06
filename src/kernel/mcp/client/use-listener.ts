// Use-notification seam: transports report each tools/call so higher layers
// can attribute server usage without the kernel importing product domains.
let listener: ((serverName: string) => void) | null = null;

export function setMcpServerUseListener(fn: ((serverName: string) => void) | null): void {
  listener = fn;
}

export function notifyMcpServerUsed(serverName: string): void {
  try {
    listener?.(serverName);
  } catch {
    // A listener failure must never break a tool call.
  }
}
