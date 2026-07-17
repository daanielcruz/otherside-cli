import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ListMcpResourcesTool,
  ReadMcpResourceDirTool,
  ReadMcpResourceTool,
} from "@/engine/tools/builtins/mcp/mcp_resources.ts";
import { closeAllClients, setMcpClientSpawnerForTests } from "@/kernel/mcp/client/registry.ts";
import { setMcpSkillsEnabledForTests } from "@/kernel/mcp/protocol/parse.ts";
import type {
  McpClient,
  McpDirectoryListPage,
  McpResourceInfo,
  McpServerCapabilities,
  McpToolInfo,
} from "@/kernel/mcp/protocol/types.ts";
import {
  MCP_INVALID_PARAMS,
  MCP_SKILLS_EXTENSION_URI,
  McpRpcError,
} from "@/kernel/mcp/protocol/types.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

class ResourceClient implements McpClient {
  closed = false;
  constructor(
    private readonly options: {
      resources?: McpResourceInfo[];
      contents?: unknown[];
      pages?: McpDirectoryListPage[];
      caps?: McpServerCapabilities | null;
      listDirectoryError?: Error;
    },
  ) {}

  async listTools(): Promise<McpToolInfo[]> {
    return [];
  }
  async callTool(): Promise<unknown> {
    return null;
  }
  async listResources(): Promise<McpResourceInfo[]> {
    return this.options.resources ?? [];
  }
  async readResource(): Promise<unknown> {
    return { contents: this.options.contents ?? [] };
  }
  async listDirectory(): Promise<McpDirectoryListPage> {
    if (this.options.listDirectoryError) throw this.options.listDirectoryError;
    return this.options.pages?.[0] ?? { resources: [] };
  }
  serverCapabilities() {
    return this.options.caps ?? null;
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

function ctx(cwd: string): RequestContext {
  return {
    provider: "anthropic",
    model: "test",
    effort: null,
    permissionMode: "default",
    sessionId: "s",
    cwd,
  };
}

describe("MCP resource tools (handlers)", () => {
  let cwd: string | undefined;
  let prevConfigDir: string | undefined;

  beforeEach(() => setMcpSkillsEnabledForTests(true));

  afterEach(async () => {
    await closeAllClients();
    setMcpClientSpawnerForTests(null);
    setMcpSkillsEnabledForTests(null);
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    cwd = undefined;
    if (prevConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
    else process.env.OTHERSIDE_CONFIG_DIR = prevConfigDir;
    prevConfigDir = undefined;
  });

  function setupServer(client: ResourceClient): void {
    prevConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    process.env.OTHERSIDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "os-mcp-user-"));
    cwd = mkdtempSync(join(tmpdir(), "os-mcp-res-tool-"));
    writeFileSync(
      join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: { demo: { type: "stdio", command: "true", args: [] } },
      }),
    );
    mkdirSync(join(cwd, ".otherside"), { recursive: true });
    writeFileSync(
      join(cwd, ".otherside", "settings.local.json"),
      JSON.stringify({ enableAllProjectMcpServers: true }),
    );
    setMcpClientSpawnerForTests(async () => client);
  }

  it("ListMcpResourcesTool uses ctx.cwd and returns resources", async () => {
    setupServer(
      new ResourceClient({
        resources: [{ uri: "file:///a", name: "a" }],
        caps: { resources: {} },
      }),
    );
    const result = await ListMcpResourcesTool.run(
      { id: "1", name: ListMcpResourcesTool.schema.name, input: {} },
      ctx(cwd!),
    );
    expect(result.is_error).toBeUndefined();
    expect(JSON.parse(result.content as string)).toEqual({
      resources: [{ uri: "file:///a", name: "a", server: "demo" }],
    });
  });

  it("ReadMcpResourceTool reads by uri", async () => {
    setupServer(
      new ResourceClient({
        contents: [{ uri: "file:///a", text: "hi" }],
        caps: { resources: {} },
      }),
    );
    const result = await ReadMcpResourceTool.run(
      {
        id: "2",
        name: ReadMcpResourceTool.schema.name,
        input: { server: "demo", uri: "file:///a" },
      },
      ctx(cwd!),
    );
    expect(result.is_error).toBeUndefined();
    expect(JSON.parse(result.content as string)).toEqual({
      contents: [{ uri: "file:///a", text: "hi" }],
    });
  });

  it("ReadMcpResourceDirTool lists children when directoryRead is true", async () => {
    setupServer(
      new ResourceClient({
        caps: {
          resources: {},
          extensions: { [MCP_SKILLS_EXTENSION_URI]: { directoryRead: true } },
        },
        pages: [
          {
            resources: [
              { uri: "file:///a", name: "a" },
              { uri: "file:///d", name: "d", mimeType: "inode/directory" },
            ],
          },
        ],
      }),
    );
    const result = await ReadMcpResourceDirTool.run(
      {
        id: "3",
        name: ReadMcpResourceDirTool.schema.name,
        input: { server: "demo", uri: "file:///" },
      },
      ctx(cwd!),
    );
    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe(
      'Directory listing (2 entries):\na\nd/\n\n{"resources":[{"uri":"file:///a","name":"a"},{"uri":"file:///d","name":"d","mimeType":"inode/directory"}]}',
    );
  });

  it("ReadMcpResourceDirTool returns the feature-gate error as a successful tool result", async () => {
    setMcpSkillsEnabledForTests(false);
    setupServer(
      new ResourceClient({
        caps: {
          resources: {},
          extensions: { [MCP_SKILLS_EXTENSION_URI]: { directoryRead: true } },
        },
      }),
    );
    const result = await ReadMcpResourceDirTool.run(
      {
        id: "3-gated",
        name: ReadMcpResourceDirTool.schema.name,
        input: { server: "demo", uri: "file:///" },
      },
      ctx(cwd!),
    );
    expect(result).toEqual({
      tool_use_id: "3-gated",
      content: "Directory listing is not enabled in this build.",
    });
  });

  it("ReadMcpResourceDirTool maps InvalidParams to not-a-directory pointing at ReadMcpResourceTool", async () => {
    setupServer(
      new ResourceClient({
        caps: {
          resources: {},
          extensions: { [MCP_SKILLS_EXTENSION_URI]: { directoryRead: true } },
        },
        listDirectoryError: new McpRpcError("resources/directory/read", {
          code: MCP_INVALID_PARAMS,
          message: "nope",
        }),
      }),
    );
    const result = await ReadMcpResourceDirTool.run(
      {
        id: "4",
        name: ReadMcpResourceDirTool.schema.name,
        input: { server: "demo", uri: "file:///leaf" },
      },
      ctx(cwd!),
    );
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Not a directory resource: file:///leaf");
    expect(result.content).toContain("ReadMcpResourceTool");
  });

  it("exposes exact wire name ReadMcpResourceDirTool", () => {
    expect(ReadMcpResourceDirTool.schema.name).toBe("ReadMcpResourceDirTool");
    expect(ReadMcpResourceDirTool.schema.description.startsWith("\nList the direct children")).toBe(
      true,
    );
  });
});
