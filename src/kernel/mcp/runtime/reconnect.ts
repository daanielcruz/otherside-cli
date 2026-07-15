import type { McpServerConfig } from "@/kernel/mcp/protocol/types.ts";

export const MAX_ERRORS_BEFORE_RECONNECT = 3;

export const RETRY_BACKOFF_MS = [500, 1500, 4000] as const;

const consecutiveErrors = new Map<string, number>();

export function isTerminalMcpError(message: string): boolean {
  return (
    message.includes("ECONNREFUSED") ||
    message.includes("ETIMEDOUT") ||
    message.includes("HTTP 500") ||
    message.includes("HTTP 502") ||
    message.includes("HTTP 504")
  );
}

export function recordMcpConnectionError(serverName: string): number {
  const count = (consecutiveErrors.get(serverName) ?? 0) + 1;
  consecutiveErrors.set(serverName, count);
  return count;
}

export function resetMcpConnectionErrors(serverName: string): void {
  consecutiveErrors.delete(serverName);
}

export function getMcpConnectionErrorCount(serverName: string): number {
  return consecutiveErrors.get(serverName) ?? 0;
}

export async function scheduleReconnect(
  serverName: string,
  config: McpServerConfig,
): Promise<void> {
  consecutiveErrors.delete(serverName);
  const registry = await import("@/kernel/mcp/client/registry.ts");
  await registry.dropClient(serverName, config);
  for (const delayMs of RETRY_BACKOFF_MS) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    try {
      await registry.clientFor(serverName, config);
      resetMcpConnectionErrors(serverName);
      return;
    } catch {}
  }
}
