import { afterEach, describe, expect, it } from "bun:test";
import type {
  McpClient,
  McpResourceInfo,
  McpServerConfig,
  McpToolInfo,
} from "@/kernel/mcp/protocol/types.ts";
import {
  clientFor,
  closeAllClients,
  dropClient,
  hasPendingMcpServers,
  keepOnlyClients,
  mcpServerStatuses,
  setMcpClientSpawnerForTests,
} from "../registry.ts";

class FakeMcpClient implements McpClient {
  private closed = false;

  async listTools(): Promise<McpToolInfo[]> {
    return [];
  }

  async callTool(): Promise<unknown> {
    return null;
  }

  async listResources(): Promise<McpResourceInfo[]> {
    return [];
  }

  async readResource(): Promise<unknown> {
    return null;
  }

  async listDirectory() {
    return { resources: [] };
  }

  serverCapabilities() {
    return null;
  }

  serverInstructions(): string | null {
    return null;
  }

  async listPrompts() {
    return [];
  }

  async getPrompt() {
    return { messages: [] };
  }

  announce(): void {}

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
  }
}

function missingSpawnResolver(): never {
  throw new Error("spawn resolver was not set");
}

const config: McpServerConfig = { type: "stdio", command: "mcp-server", args: ["--demo"] };

describe("MCP client registry", () => {
  afterEach(async () => {
    await closeAllClients();
    setMcpClientSpawnerForTests(null);
  });

  it("reports pending session servers until their connection settles", async () => {
    let resolveSpawn: (client: McpClient) => void = missingSpawnResolver;
    setMcpClientSpawnerForTests(
      () =>
        new Promise<McpClient>((resolve) => {
          resolveSpawn = resolve;
        }),
    );

    expect(hasPendingMcpServers()).toBe(false);
    const connection = clientFor("playwright", config);
    expect(hasPendingMcpServers()).toBe(true);

    resolveSpawn(new FakeMcpClient());
    await connection;
    expect(hasPendingMcpServers()).toBe(false);
  });

  it("deduplicates concurrent spawns for the same server key", async () => {
    let spawnCount = 0;
    let resolveSpawn: (client: McpClient) => void = missingSpawnResolver;
    setMcpClientSpawnerForTests(
      () =>
        new Promise<McpClient>((resolve) => {
          spawnCount += 1;
          resolveSpawn = resolve;
        }),
    );

    const first = clientFor("playwright", config);
    const second = clientFor("playwright", config);
    await Promise.resolve();

    expect(spawnCount).toBe(1);
    const client = new FakeMcpClient();
    resolveSpawn(client);

    expect(await first).toBe(client);
    expect(await second).toBe(client);
    expect(await clientFor("playwright", config)).toBe(client);
    expect(spawnCount).toBe(1);
  });

  it("does not share clients for configs with different environment", async () => {
    let spawnCount = 0;
    setMcpClientSpawnerForTests(async () => {
      spawnCount += 1;
      return new FakeMcpClient();
    });

    const first = await clientFor("playwright", config);
    const second = await clientFor("playwright", {
      ...config,
      env: { PROFILE: "isolated" },
    });

    expect(second).not.toBe(first);
    expect(spawnCount).toBe(2);
  });

  it("spawns a replacement after a cached client closes", async () => {
    let spawnCount = 0;
    setMcpClientSpawnerForTests(async () => {
      spawnCount += 1;
      return new FakeMcpClient();
    });

    const first = await clientFor("playwright", config);
    first.close();
    const second = await clientFor("playwright", config);

    expect(second).not.toBe(first);
    expect(spawnCount).toBe(2);
  });

  it("does not cache a client that resolves after closeAllClients", async () => {
    let spawnCount = 0;
    let resolveFirst: (client: McpClient) => void = missingSpawnResolver;
    setMcpClientSpawnerForTests(async () => {
      spawnCount += 1;
      if (spawnCount === 1) {
        return new Promise<McpClient>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return new FakeMcpClient();
    });

    const firstPromise = clientFor("playwright", config);
    await Promise.resolve();
    const closePromise = closeAllClients();
    const first = new FakeMcpClient();
    resolveFirst(first);

    await closePromise;
    expect(await firstPromise).toBe(first);
    expect(first.isClosed()).toBe(true);
    const second = await clientFor("playwright", config);

    expect(second).not.toBe(first);
    expect(second.isClosed()).toBe(false);
    expect(spawnCount).toBe(2);
  });

  it("does not cache a client that resolves after dropClient", async () => {
    let spawnCount = 0;
    let resolveFirst: (client: McpClient) => void = missingSpawnResolver;
    setMcpClientSpawnerForTests(async () => {
      spawnCount += 1;
      if (spawnCount === 1) {
        return new Promise<McpClient>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return new FakeMcpClient();
    });

    const firstPromise = clientFor("playwright", config);
    await Promise.resolve();
    const dropPromise = dropClient("playwright", config);
    const first = new FakeMcpClient();
    resolveFirst(first);

    await dropPromise;
    expect(await firstPromise).toBe(first);
    expect(first.isClosed()).toBe(true);
    const second = await clientFor("playwright", config);

    expect(second).not.toBe(first);
    expect(spawnCount).toBe(2);
  });

  it("keeps a plugin MCP name in the session lifecycle despite its namespace separators", async () => {
    setMcpClientSpawnerForTests(async () => new FakeMcpClient());
    const pluginName = "plugin:demo@market:playwright";

    const client = await clientFor(pluginName, config);

    expect(mcpServerStatuses([pluginName])).toEqual([{ name: pluginName, status: "connected" }]);
    await keepOnlyClients([]);
    expect(client.isClosed()).toBe(true);
    expect(hasPendingMcpServers()).toBe(false);
    expect(mcpServerStatuses([pluginName])).toEqual([{ name: pluginName, status: "pending" }]);
  });

  it("keeps only active clients and closes others when keepOnlyClients is called", async () => {
    let spawnCount = 0;
    setMcpClientSpawnerForTests(async () => {
      spawnCount += 1;
      return new FakeMcpClient();
    });

    const first = await clientFor("playwright", config);
    const second = await clientFor("gcal", { type: "http", url: "https://gcal" });

    expect(spawnCount).toBe(2);
    expect(first.isClosed()).toBe(false);
    expect(second.isClosed()).toBe(false);

    await keepOnlyClients([{ name: "playwright", config }]);

    expect(first.isClosed()).toBe(false);
    expect(second.isClosed()).toBe(true);

    const third = await clientFor("gcal", { type: "http", url: "https://gcal" });
    expect(third).not.toBe(second);
    expect(spawnCount).toBe(3);
  });
});
