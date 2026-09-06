import { afterEach, describe, expect, test } from "bun:test";
import { closeAllClients, setMcpClientSpawnerForTests } from "@/kernel/mcp/client/registry.ts";
import {
  type McpCallToolOptions,
  type McpClient,
  type McpResourceInfo,
  type McpToolInfo,
} from "@/kernel/mcp/protocol/types.ts";
import { loadNamespacedMcpRuntime } from "@/kernel/mcp/runtime/manager.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

class HangingClient implements McpClient {
  closed = false;
  lastSignal: AbortSignal | undefined;

  async listTools(): Promise<McpToolInfo[]> {
    return [
      {
        name: "hang",
        description: "never returns unless aborted",
        inputSchema: { type: "object" },
      },
    ];
  }

  callTool(_name: string, _args: unknown, options?: McpCallToolOptions): Promise<unknown> {
    this.lastSignal = options?.signal;
    return new Promise((_resolve, reject) => {
      const signal = options?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
        once: true,
      });
    });
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

function ctx(signal?: AbortSignal): RequestContext {
  return {
    provider: "anthropic",
    model: "test-model",
    effort: null,
    permissionMode: "default",
    sessionId: "mcp-abort-test",
    cwd: process.cwd(),
    ...(signal ? { abortSignal: signal } : {}),
  };
}

describe("MCP callTool respects the turn signal", () => {
  afterEach(async () => {
    setMcpClientSpawnerForTests(null);
    await closeAllClients();
  });

  test("a live abort ends a hanging MCP tool as Interrupted by user", async () => {
    const client = new HangingClient();
    setMcpClientSpawnerForTests(async () => client);
    const runtime = await loadNamespacedMcpRuntime({
      namespace: "abort-test",
      servers: { hang: { type: "stdio", command: "hang", args: [] } },
    });
    try {
      const handler = runtime.handlers.find((h) => h.schema.name.includes("hang"));
      expect(handler).toBeDefined();

      const abort = new AbortController();
      const run = handler!.run(
        { id: "call-1", name: handler!.schema.name, input: {} },
        ctx(abort.signal),
      );
      await Promise.resolve();
      expect(client.lastSignal).toBe(abort.signal);
      abort.abort();
      const result = await run;
      expect(result.is_error).toBe(true);
      expect(result.content).toBe("Interrupted by user");
    } finally {
      await runtime.close();
    }
  });

  test("a pre-aborted turn never reaches the server", async () => {
    const client = new HangingClient();
    setMcpClientSpawnerForTests(async () => client);
    const runtime = await loadNamespacedMcpRuntime({
      namespace: "abort-test-pre",
      servers: { hang: { type: "stdio", command: "hang", args: [] } },
    });
    try {
      const handler = runtime.handlers.find((h) => h.schema.name.includes("hang"));
      expect(handler).toBeDefined();

      const abort = new AbortController();
      abort.abort();
      const result = await handler!.run(
        { id: "call-2", name: handler!.schema.name, input: {} },
        ctx(abort.signal),
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toBe("Interrupted by user");
      expect(client.lastSignal).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });
});
