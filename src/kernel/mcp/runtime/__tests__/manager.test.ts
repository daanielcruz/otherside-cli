import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { partitionForConcurrency } from "@/engine/queue/runtime/concurrency.ts";
import * as toolsRegistry from "@/engine/tools/registry.ts";
import { closeAllClients, setMcpClientSpawnerForTests } from "@/kernel/mcp/client/registry.ts";
import { loadEnabledMcpConfig } from "@/kernel/mcp/config.ts";
import { setMcpOAuthFlowStarterForTests } from "@/kernel/mcp/oauth/flow.ts";
import {
  type McpClient,
  type McpResourceInfo,
  type McpServerConfig,
  type McpToolInfo,
  UnauthorizedError,
} from "@/kernel/mcp/protocol/types.ts";
import {
  buildMcpRuntime,
  loadNamespacedMcpRuntime,
  refreshMcpTools,
  setMcpToolRegistry,
} from "@/kernel/mcp/runtime/manager.ts";
import type { ToolHandler } from "@/kernel/std/tool-contract.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

class FakeMcpClient implements McpClient {
  closed = false;
  readonly calls: { name: string; args: unknown }[] = [];

  constructor(private readonly tools: McpToolInfo[]) {}

  async listTools(): Promise<McpToolInfo[]> {
    return this.tools;
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    this.calls.push({ name, args });
    return { content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }] };
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

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
  }
}

const config: McpServerConfig = { type: "stdio", command: "mcp-test", args: [] };

function ctx(): RequestContext {
  return {
    provider: "anthropic",
    model: "test-model",
    effort: null,
    permissionMode: "default",
    sessionId: "mcp-runtime-test-session",
    cwd: mkdtempSync(join(tmpdir(), "otherside-finalize-mcp-runtime-")),
  };
}

describe("namespaced MCP runtime", () => {
  afterEach(async () => {
    await closeAllClients();
    setMcpClientSpawnerForTests(null);
  });

  test("binds handlers to a namespaced client and closes it", async () => {
    const clients: FakeMcpClient[] = [];
    setMcpClientSpawnerForTests(async () => {
      const client = new FakeMcpClient([
        { name: "echo", description: "Echo input", inputSchema: { type: "object" } },
      ]);
      clients.push(client);
      return client;
    });

    const runtime = await loadNamespacedMcpRuntime({
      namespace: "fork:runtime-test",
      servers: { inline: config },
    });

    expect(runtime.failures).toEqual([]);
    expect(runtime.handlers.map((handler) => handler.schema.name)).toEqual(["mcp__inline__echo"]);

    const result = await runtime.handlers[0]!.run(
      { id: "call-1", name: "mcp__inline__echo", input: { value: "ok" } },
      ctx(),
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: 'echo:{"value":"ok"}' }]);
    expect(clients[0]!.calls).toEqual([{ name: "echo", args: { value: "ok" } }]);

    await runtime.close();

    expect(clients[0]!.isClosed()).toBe(true);
  });

  test("reports spawn failures without throwing", async () => {
    setMcpClientSpawnerForTests(async () => {
      throw new Error("spawn failed");
    });

    const runtime = await loadNamespacedMcpRuntime({
      namespace: "fork:runtime-failure-test",
      servers: { broken: config },
    });

    expect(runtime.handlers).toEqual([]);
    expect(runtime.failures).toEqual([{ server: "broken", error: "spawn failed" }]);

    await runtime.close();
  });

  test("batches consecutive read-only MCP tools", async () => {
    const tools: McpToolInfo[] = [
      {
        name: "first_read",
        description: "First read",
        inputSchema: { type: "object" },
        readOnlyHint: true,
      },
      {
        name: "second_read",
        description: "Second read",
        inputSchema: { type: "object" },
        readOnlyHint: true,
      },
      {
        name: "write",
        description: "Write",
        inputSchema: { type: "object" },
      },
    ];
    setMcpClientSpawnerForTests(async () => new FakeMcpClient(tools));

    const runtime = await buildMcpRuntime({ inspector: config });
    const namespacedRuntime = await loadNamespacedMcpRuntime({
      namespace: "fork:read-only-tools",
      servers: { inspector: config },
    });
    const handlerNames = runtime.handlers.map((handler) => handler.schema.name);

    try {
      expect(runtime.handlers.map((handler) => handler.isConcurrencySafe)).toEqual([
        true,
        true,
        false,
      ]);
      expect(namespacedRuntime.handlers.map((handler) => handler.isConcurrencySafe)).toEqual([
        true,
        true,
        false,
      ]);

      for (const handler of runtime.handlers) toolsRegistry.register(handler);
      expect(
        partitionForConcurrency(
          handlerNames.map((name, index) => ({ id: `call-${index}`, name, input: {} })),
        ).map((group) => group.map((call) => call.name)),
      ).toEqual([[handlerNames[0]!, handlerNames[1]!], [handlerNames[2]!]]);
    } finally {
      for (const name of handlerNames) toolsRegistry.unregister(name);
      await namespacedRuntime.close();
    }
  });
});

describe("buildMcpRuntime auth stubs", () => {
  afterEach(async () => {
    await closeAllClients();
    setMcpClientSpawnerForTests(null);
    setMcpOAuthFlowStarterForTests(null);
    setMcpToolRegistry({
      register: () => {},
      registerWithNamespace: () => {},
      unregister: () => {},
    });
  });

  const httpConfig: McpServerConfig = {
    type: "http",
    url: "http://localhost:13337",
  };

  test("does not advertise authenticate when HTTP fails for a non-auth reason", async () => {
    setMcpClientSpawnerForTests(async () => {
      throw new Error(
        `MCP \`initialize\` error: ${JSON.stringify({ code: -32601, message: "Method 'initialize' not found" })}`,
      );
    });

    const runtime = await buildMcpRuntime({ ida: httpConfig });
    const names = runtime.handlers.map((handler) => handler.schema.name);

    expect(names).toEqual([]);
    expect(names).not.toContain("mcp__ida__authenticate");
    expect(names).not.toContain("mcp__ida__complete_authentication");
  });

  test("advertises authenticate only when the server returns needs-auth", async () => {
    setMcpClientSpawnerForTests(async () => {
      throw new UnauthorizedError({
        message: "MCP http `remote` initialize → HTTP 401",
        challenge: 'Bearer realm="mcp"',
        resourceMetadataUrl: null,
      });
    });

    const runtime = await buildMcpRuntime({
      remote: { type: "http", url: "https://example.com/mcp" },
    });
    const names = runtime.handlers.map((handler) => handler.schema.name);

    expect(names).toContain("mcp__remote__authenticate");
    expect(names).toContain("mcp__remote__complete_authentication");
    expect(
      names.filter(
        (name) => !name.includes("authenticate") && !name.includes("complete_authentication"),
      ),
    ).toEqual([]);
  });

  test("replaces auth stubs with real tools after OAuth while keeping pending and denied servers hidden", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-oauth-refresh-"));
    const userConfigDir = join(root, "user");
    const previousConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    const handlers = new Map<string, ToolHandler>();
    let authorized = false;
    let submittedCallback = "";
    let resolveFlow: ((outcome: { kind: "saved"; expiresAt: number }) => void) | null = null;

    mkdirSync(userConfigDir, { recursive: true });
    mkdirSync(join(root, ".otherside"), { recursive: true });
    writeFileSync(
      join(userConfigDir, "mcp.json"),
      JSON.stringify({ mcpServers: { remote: httpConfig } }),
    );
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          pending: config,
          denied: config,
        },
      }),
    );
    writeFileSync(
      join(root, ".otherside", "settings.json"),
      JSON.stringify({
        disabledMcpjsonServers: ["denied"],
      }),
    );
    writeFileSync(
      join(root, ".otherside", "settings.local.json"),
      JSON.stringify({
        enabledMcpjsonServers: ["denied"],
      }),
    );
    process.env.OTHERSIDE_CONFIG_DIR = userConfigDir;

    setMcpToolRegistry({
      register: (handler) => handlers.set(handler.schema.name, handler),
      registerWithNamespace: (_namespace, handler) => handlers.set(handler.schema.name, handler),
      unregister: (name) => handlers.delete(name),
    });
    setMcpClientSpawnerForTests(async () => {
      if (!authorized) {
        throw new UnauthorizedError({
          message: "MCP http `remote` initialize → HTTP 401",
          challenge: 'Bearer realm="mcp"',
          resourceMetadataUrl: null,
        });
      }
      return new FakeMcpClient([
        { name: "search", description: "Search", inputSchema: { type: "object" } },
      ]);
    });
    setMcpOAuthFlowStarterForTests(async () => ({
      authUrl: "https://auth.example/authorize",
      callbackPort: 0,
      done: new Promise((resolve) => {
        resolveFlow = resolve;
      }),
      submitCode: (callbackUrl) => {
        submittedCallback = callbackUrl;
        authorized = true;
        resolveFlow?.({ kind: "saved", expiresAt: 0 });
      },
    }));

    try {
      await refreshMcpTools(root);
      expect([...handlers.keys()].sort()).toEqual([
        "mcp__remote__authenticate",
        "mcp__remote__complete_authentication",
      ]);
      expect(handlers.has("mcp__pending__authenticate")).toBe(false);
      expect(handlers.has("mcp__denied__authenticate")).toBe(false);

      const authenticate = handlers.get("mcp__remote__authenticate");
      const completeAuthentication = handlers.get("mcp__remote__complete_authentication");
      if (!authenticate || !completeAuthentication)
        throw new Error("OAuth tools were not registered");

      await authenticate.run(
        { id: "start", name: "mcp__remote__authenticate", input: {} },
        { ...ctx(), cwd: root },
      );
      const completion = await completeAuthentication.run(
        {
          id: "complete",
          name: "mcp__remote__complete_authentication",
          input: { callback_url: "http://localhost/callback?code=valid&state=state" },
        },
        { ...ctx(), cwd: root },
      );

      expect(submittedCallback).toBe("http://localhost/callback?code=valid&state=state");
      expect(JSON.parse(String(completion.content))).toMatchObject({ status: "success" });
      expect([...handlers.keys()]).toEqual(["mcp__remote__search"]);
      expect(handlers.has("mcp__pending__search")).toBe(false);
      expect(handlers.has("mcp__denied__search")).toBe(false);
    } finally {
      if (previousConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
      else process.env.OTHERSIDE_CONFIG_DIR = previousConfigDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("registers real tools without authenticate when HTTP connects cleanly", async () => {
    setMcpClientSpawnerForTests(async () => {
      return new FakeMcpClient([
        {
          name: "check_connection",
          description: "Check IDA",
          inputSchema: { type: "object", properties: {} },
        },
      ]);
    });

    const runtime = await buildMcpRuntime({ "ida-pro-mcp": httpConfig });
    const names = runtime.handlers.map((handler) => handler.schema.name);

    expect(names).toEqual(["mcp__ida-pro-mcp__check_connection"]);
    expect(names).not.toContain("mcp__ida-pro-mcp__authenticate");
  });
});

describe("MCP config normalization", () => {
  test("preserves stdio cwd and expands environment values with defaults", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-config-"));
    const previousConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
    const previousToken = process.env.MCP_CONFIG_TEST_TOKEN;
    process.env.OTHERSIDE_CONFIG_DIR = root;
    process.env.MCP_CONFIG_TEST_TOKEN = "secret";
    try {
      writeFileSync(
        join(root, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            local: {
              type: "stdio",
              command: "${MCP_CONFIG_TEST_COMMAND:-node}",
              args: ["${MCP_CONFIG_TEST_ARG:-server.js}"],
              env: { TOKEN: "${MCP_CONFIG_TEST_TOKEN}" },
              cwd: "${MCP_CONFIG_TEST_CWD:-/tmp/mcp-workdir}",
            },
          },
        }),
      );

      const config = await loadEnabledMcpConfig(root);

      expect(config.mcpServers.local).toEqual({
        type: "stdio",
        command: "node",
        args: ["server.js"],
        env: { TOKEN: "secret" },
        cwd: "/tmp/mcp-workdir",
      });
    } finally {
      if (previousConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
      else process.env.OTHERSIDE_CONFIG_DIR = previousConfigDir;
      if (previousToken === undefined) delete process.env.MCP_CONFIG_TEST_TOKEN;
      else process.env.MCP_CONFIG_TEST_TOKEN = previousToken;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
