import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeAllClients,
  hasConnectedResourcesCapableMcpServer,
  setMcpClientSpawnerForTests,
} from "@/kernel/mcp/client/registry.ts";
import { boundMcpResourceOutput, readMcpDirectory } from "@/kernel/mcp/client/resources.ts";
import type {
  McpClient,
  McpDirectoryListPage,
  McpResourceInfo,
  McpServerCapabilities,
  McpToolInfo,
} from "@/kernel/mcp/protocol/types.ts";
import {
  MAX_MCP_RESOURCE_OUTPUT_CHARS,
  MCP_INVALID_PARAMS,
  MCP_SKILLS_EXTENSION_URI,
  McpRpcError,
} from "@/kernel/mcp/protocol/types.ts";

class DirFakeClient implements McpClient {
  closed = false;
  pages: McpDirectoryListPage[];
  caps: McpServerCapabilities | null;
  calls = 0;
  private onList: ((uri: string, cursor?: string) => McpDirectoryListPage) | undefined;

  constructor(options: {
    pages?: McpDirectoryListPage[];
    caps?: McpServerCapabilities | null;
    onList?: (uri: string, cursor?: string) => McpDirectoryListPage;
  }) {
    this.pages = options.pages ?? [];
    this.caps = options.caps ?? null;
    this.onList = options.onList ?? undefined;
  }

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
  async listDirectory(uri: string, options?: { cursor?: string }): Promise<McpDirectoryListPage> {
    this.calls++;
    if (this.onList) return this.onList(uri, options?.cursor);
    const idx = options?.cursor ? Number(options.cursor) : 0;
    return this.pages[idx] ?? { resources: [] };
  }
  serverCapabilities() {
    return this.caps;
  }
  serverInstructions() {
    return null;
  }
  isClosed() {
    return this.closed;
  }
  close() {
    this.closed = true;
  }
}

function writeTrustedProject(cwd: string, serverName = "res"): void {
  writeFileSync(
    join(cwd, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        [serverName]: { type: "stdio", command: "true", args: [] },
      },
    }),
  );
  mkdirSync(join(cwd, ".otherside"), { recursive: true });
  writeFileSync(
    join(cwd, ".otherside", "settings.local.json"),
    JSON.stringify({ enableAllProjectMcpServers: true }),
  );
}

describe("readMcpDirectory + resource-capable gate", () => {
  let cwd: string | undefined;
  let prevConfigDir: string | undefined;

  afterEach(async () => {
    await closeAllClients();
    setMcpClientSpawnerForTests(null);
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    cwd = undefined;
    if (prevConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = prevConfigDir;
    prevConfigDir = undefined;
  });

  function isolateHome(): void {
    prevConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    const user = mkdtempSync(join(tmpdir(), "os-mcp-user-"));
    process.env.OTHERSIDE_CONFIG_DIR = user;
  }

  it("tracks hasConnectedResourcesCapableMcpServer from capabilities.resources", async () => {
    expect(hasConnectedResourcesCapableMcpServer()).toBe(false);
    setMcpClientSpawnerForTests(async () => new DirFakeClient({ caps: { resources: {} } }));
    const { clientFor } = await import("@/kernel/mcp/client/registry.ts");
    await clientFor("res", { type: "stdio", command: "true", args: [] });
    expect(hasConnectedResourcesCapableMcpServer()).toBe(true);
    await closeAllClients();
    expect(hasConnectedResourcesCapableMcpServer()).toBe(false);
  });

  it("does not mark resource-capable without resources capability", async () => {
    setMcpClientSpawnerForTests(async () => new DirFakeClient({ caps: { tools: {} } }));
    const { clientFor } = await import("@/kernel/mcp/client/registry.ts");
    await clientFor("plain", { type: "stdio", command: "true", args: [] });
    expect(hasConnectedResourcesCapableMcpServer()).toBe(false);
  });

  it("returns no-directory-read when directoryRead is absent", async () => {
    isolateHome();
    cwd = mkdtempSync(join(tmpdir(), "os-mcp-dir-"));
    writeTrustedProject(cwd);
    setMcpClientSpawnerForTests(async () => new DirFakeClient({ caps: { resources: {} } }));
    const result = await readMcpDirectory({ cwd, server: "res", uri: "file:///root" });
    expect(result.kind).toBe("no-directory-read");
  });

  it("paginates and sanitizes entries when directoryRead is true", async () => {
    isolateHome();
    cwd = mkdtempSync(join(tmpdir(), "os-mcp-dir-"));
    writeTrustedProject(cwd);
    setMcpClientSpawnerForTests(
      async () =>
        new DirFakeClient({
          caps: {
            resources: {},
            extensions: { [MCP_SKILLS_EXTENSION_URI]: { directoryRead: true } },
          },
          pages: [
            {
              resources: [
                { uri: "file:///a", name: "a\u200B", mimeType: "text/plain" },
                { uri: "file:///d", name: "d", mimeType: "inode/directory" },
              ],
              nextCursor: "1",
            },
            {
              resources: [{ uri: "file:///b", name: "b" }],
            },
          ],
        }),
    );
    const result = await readMcpDirectory({ cwd, server: "res", uri: "file:///root" });
    expect(result).toEqual({
      kind: "ok",
      resources: [
        { uri: "file:///a", name: "a", mimeType: "text/plain" },
        { uri: "file:///d", name: "d", mimeType: "inode/directory" },
        { uri: "file:///b", name: "b" },
      ],
    });
  });

  it("InvalidParams on page 1 => not-directory", async () => {
    isolateHome();
    cwd = mkdtempSync(join(tmpdir(), "os-mcp-dir-"));
    writeTrustedProject(cwd);
    setMcpClientSpawnerForTests(
      async () =>
        new DirFakeClient({
          caps: {
            resources: {},
            extensions: { [MCP_SKILLS_EXTENSION_URI]: { directoryRead: true } },
          },
          onList: () => {
            throw new McpRpcError("resources/directory/read", {
              code: MCP_INVALID_PARAMS,
              message: "not a directory",
            });
          },
        }),
    );
    const result = await readMcpDirectory({ cwd, server: "res", uri: "file:///leaf" });
    expect(result).toEqual({ kind: "not-directory", uri: "file:///leaf" });
  });

  it("InvalidParams after page 1 returns accumulated entries", async () => {
    isolateHome();
    cwd = mkdtempSync(join(tmpdir(), "os-mcp-dir-"));
    writeTrustedProject(cwd);
    let calls = 0;
    setMcpClientSpawnerForTests(
      async () =>
        new DirFakeClient({
          caps: {
            resources: {},
            extensions: { [MCP_SKILLS_EXTENSION_URI]: { directoryRead: true } },
          },
          onList: (_uri, cursor) => {
            calls++;
            if (!cursor) {
              return {
                resources: [{ uri: "file:///a", name: "a" }],
                nextCursor: "next",
              };
            }
            throw new McpRpcError("resources/directory/read", {
              code: MCP_INVALID_PARAMS,
              message: "bad cursor",
            });
          },
        }),
    );
    const result = await readMcpDirectory({ cwd, server: "res", uri: "file:///root" });
    expect(calls).toBe(2);
    expect(result).toEqual({
      kind: "ok",
      resources: [{ uri: "file:///a", name: "a" }],
    });
  });

  it("boundMcpResourceOutput truncates past 100k chars", () => {
    const big = { x: "y".repeat(MAX_MCP_RESOURCE_OUTPUT_CHARS) };
    const out = boundMcpResourceOutput(big);
    expect(out.length).toBeLessThanOrEqual(MAX_MCP_RESOURCE_OUTPUT_CHARS + 20);
    expect(out.endsWith("...[truncated]")).toBe(true);
  });
});
