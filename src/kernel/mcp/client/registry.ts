import { hasResourcesCapability } from "@/kernel/mcp/protocol/parse.ts";
import type {
  McpClient,
  McpServerConfig,
  McpServerInspection,
} from "@/kernel/mcp/protocol/types.ts";
import { UnauthorizedError } from "@/kernel/mcp/protocol/types.ts";
import { HttpTransport } from "@/kernel/mcp/transport/http.ts";
import { SseTransport } from "@/kernel/mcp/transport/sse.ts";
import { StdioTransport } from "@/kernel/mcp/transport/stdio.ts";

type ClientSpawner = (name: string, config: McpServerConfig) => Promise<McpClient>;
export type McpConnectionStatus = "connected" | "failed" | "needs-auth" | "pending";
export interface McpServerStatusEntry {
  name: string;
  status: McpConnectionStatus;
}

const clients = new Map<string, Promise<McpClient>>();
const serverStatuses = new Map<string, McpServerStatusEntry>();
/** Status names owned by the main session, including plugin MCP names containing `:`. */
const sessionStatusNames = new Set<string>();
/** Session-scoped names of connected servers that advertised `capabilities.resources`. */
const resourceCapableSessionServers = new Set<string>();
let clientSpawnerOverride: ClientSpawner | null = null;

function clearResourceCapable(statusName: string): void {
  resourceCapableSessionServers.delete(statusName);
}

function markResourceCapable(statusName: string, client: McpClient): void {
  if (!sessionStatusNames.has(statusName)) return;
  if (hasResourcesCapability(client.serverCapabilities())) {
    resourceCapableSessionServers.add(statusName);
  } else {
    resourceCapableSessionServers.delete(statusName);
  }
}

/**
 * Synchronous catalog gate for ListMcpResourcesTool / ReadMcpResourceTool /
 * ReadMcpResourceDirTool. True when at least one session MCP client is
 * connected and advertised `capabilities.resources`. DirectoryRead is a
 * call-time check, not an appearance gate.
 */
export function hasConnectedResourcesCapableMcpServer(): boolean {
  return resourceCapableSessionServers.size > 0;
}

function clientKey(name: string, config: McpServerConfig, namespace = "session"): string {
  return `${namespace}:${name}-${JSON.stringify(config)}`;
}

async function spawnClient(name: string, config: McpServerConfig): Promise<McpClient> {
  if (clientSpawnerOverride) return clientSpawnerOverride(name, config);
  if (config.type === "http") return HttpTransport.create(name, config);
  if (config.type === "sse") return SseTransport.create(name, config);
  return StdioTransport.spawn(config);
}

export function setMcpClientSpawnerForTests(spawner: ClientSpawner | null): void {
  clientSpawnerOverride = spawner;
}

function trackClient(
  name: string,
  config: McpServerConfig,
  key: string,
  statusName = name,
  sessionOwned = false,
): Promise<McpClient> {
  if (sessionOwned) sessionStatusNames.add(statusName);
  serverStatuses.set(statusName, { name: statusName, status: "pending" });
  const spawned = spawnClient(name, config);
  const tracked = spawned.then(
    (client) => {
      if (clients.get(key) !== tracked) {
        client.close();
        return client;
      }
      serverStatuses.set(statusName, { name: statusName, status: "connected" });
      markResourceCapable(statusName, client);
      return client;
    },
    (error) => {
      if (clients.get(key) === tracked) {
        serverStatuses.set(statusName, {
          name: statusName,
          status: error instanceof UnauthorizedError ? "needs-auth" : "failed",
        });
        clearResourceCapable(statusName);
      }
      throw error;
    },
  );
  return tracked;
}

async function resolveCachedClient(
  key: string,
  tracked: Promise<McpClient>,
  statusName?: string,
): Promise<McpClient | null> {
  try {
    const client = await tracked;
    if (!client.isClosed()) return client;
    if (clients.get(key) !== tracked) return client;
    clients.delete(key);
    if (statusName) clearResourceCapable(statusName);
    return null;
  } catch (error) {
    if (clients.get(key) === tracked) {
      clients.delete(key);
      if (statusName) clearResourceCapable(statusName);
    }
    throw error;
  }
}

async function closeClient(tracked: Promise<McpClient>): Promise<void> {
  try {
    const client = await tracked;
    client.close();
  } catch {}
}

async function clientForKey(
  namespace: string,
  name: string,
  config: McpServerConfig,
  statusName = name,
): Promise<McpClient> {
  const key = clientKey(name, config, namespace);
  while (true) {
    const cached = clients.get(key);
    if (cached) {
      const client = await resolveCachedClient(key, cached, statusName);
      if (client) return client;
      continue;
    }
    const tracked = trackClient(name, config, key, statusName, namespace === "session");
    clients.set(key, tracked);
    const client = await resolveCachedClient(key, tracked, statusName);
    if (client) return client;
  }
}

export async function clientFor(name: string, config: McpServerConfig): Promise<McpClient> {
  return clientForKey("session", name, config);
}

export async function clientForNamespace(
  namespace: string,
  name: string,
  config: McpServerConfig,
): Promise<McpClient> {
  return clientForKey(namespace, name, config, `${namespace}:${name}`);
}

export async function dropClient(name: string, config: McpServerConfig): Promise<void> {
  const key = clientKey(name, config);
  const existing = clients.get(key);
  if (!existing) return;
  clients.delete(key);
  serverStatuses.delete(name);
  sessionStatusNames.delete(name);
  clearResourceCapable(name);
  await closeClient(existing);
}

export async function dropClientsForNamespace(namespace: string): Promise<void> {
  const prefix = `${namespace}:`;
  const existing: Promise<McpClient>[] = [];
  for (const [key, tracked] of clients.entries()) {
    if (!key.startsWith(prefix)) continue;
    clients.delete(key);
    existing.push(tracked);
  }
  for (const name of serverStatuses.keys()) {
    if (name.startsWith(prefix)) {
      serverStatuses.delete(name);
      clearResourceCapable(name);
    }
  }
  await Promise.all(existing.map(closeClient));
}

export function mcpServerStatuses(names: string[]): McpServerStatusEntry[] {
  return names.map((name) => serverStatuses.get(name) ?? { name, status: "pending" });
}

export function hasPendingMcpServers(): boolean {
  return [...sessionStatusNames].some((name) => serverStatuses.get(name)?.status === "pending");
}

export async function keepOnlyClients(
  active: { name: string; config: McpServerConfig }[],
): Promise<void> {
  const activeKeys = new Set(active.map((a) => clientKey(a.name, a.config)));
  const toClose: Promise<McpClient>[] = [];
  const activeNames = new Set(active.map((a) => a.name));
  for (const name of sessionStatusNames) {
    if (!activeNames.has(name)) {
      serverStatuses.delete(name);
      sessionStatusNames.delete(name);
      clearResourceCapable(name);
    }
  }
  for (const [key, tracked] of clients.entries()) {
    if (!key.startsWith("session:")) continue;
    if (!activeKeys.has(key)) {
      clients.delete(key);
      toClose.push(tracked);
    }
  }
  await Promise.all(toClose.map(closeClient));
}

export async function closeAllClients(): Promise<void> {
  const existing = [...clients.values()];
  clients.clear();
  serverStatuses.clear();
  sessionStatusNames.clear();
  resourceCapableSessionServers.clear();
  await Promise.all(existing.map(closeClient));
}

export const MCP_DISABLED_INSPECTION: McpServerInspection = {
  status: "disabled",
  statusText: "○ disabled",
  tools: [],
  error: null,
};

export async function inspectServer(
  name: string,
  config: McpServerConfig,
): Promise<McpServerInspection> {
  try {
    const client = await clientFor(name, config);
    const tools = await client.listTools();
    return { status: "connected", statusText: "✔ connected", tools, error: null };
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return {
        status: "needs-auth",
        statusText: "⚠ needs auth",
        tools: [],
        error: e.message,
      };
    }
    return {
      status: "failed",
      statusText: "✘ failed",
      tools: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
