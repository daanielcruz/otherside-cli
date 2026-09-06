import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithPermissionResolver } from "@/engine/agents/agent-context.ts";
import { runForkLoopExternal } from "@/engine/background/subagents/dispatcher.ts";
import type { Provider } from "@/engine/contract/types.ts";
import * as providers from "@/engine/providers/registry.ts";
import * as toolRegistry from "@/engine/tools/registry.ts";
import { closeAllClients, setMcpClientSpawnerForTests } from "@/kernel/mcp/client/registry.ts";
import type {
  McpClient,
  McpResourceInfo,
  McpServerConfig,
  McpToolInfo,
} from "@/kernel/mcp/protocol/types.ts";
import type { ProviderEvent } from "@/kernel/std/types/events.ts";
import type { Message } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

const providerId = "inline-mcp-test" as RequestContext["provider"];
const model = "inline-mcp-model";
const config: McpServerConfig = { type: "stdio", command: "mcp-test", args: [] };
const toolName = "mcp__inline__echo";

class FakeMcpClient implements McpClient {
  closed = false;
  readonly calls: { name: string; args: unknown }[] = [];

  async listTools(): Promise<McpToolInfo[]> {
    return [{ name: "echo", description: "Echo input", inputSchema: { type: "object" } }];
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    this.calls.push({ name, args });
    return { content: [{ type: "text", text: `tool-result:${JSON.stringify(args)}` }] };
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

type RequestCapture = { messages: Message[]; tools: unknown[] };

function makeCtx(): RequestContext {
  return {
    provider: providerId,
    model,
    effort: null,
    permissionMode: "default",
    sessionId: `inline-mcp-${crypto.randomUUID()}`,
    cwd: mkdtempSync(join(tmpdir(), "otherside-finalize-inline-mcp-")),
  };
}

function registerProvider(eventsByTurn: ProviderEvent[][], captures: RequestCapture[]): void {
  let streamIndex = 0;
  const provider = {
    id: providerId,
    deferredOverrides: () => ({
      excludeFromCatalog: [],
      alwaysDeclare: [],
      emitDeferredReminder: false,
    }),
    translateRequest: (_ctx: RequestContext, messages: Message[], tools: unknown[]) => {
      captures.push({ messages, tools });
      return { request: captures.length };
    },
    startStreamAttempt: () => {
      const events = eventsByTurn[streamIndex] ?? [];
      streamIndex += 1;
      return {
        events: (async function* () {
          for (const event of events) yield event;
        })(),
        abort: () => {},
      };
    },
    recoverableError: () => ({ kind: "fail", reason: "test" }),
  } as unknown as Provider;
  providers.register(provider);
}

describe("fork inline MCP servers", () => {
  afterEach(async () => {
    await closeAllClients();
    setMcpClientSpawnerForTests(null);
  });

  test("adds inline MCP tools only to the fork and closes the client", async () => {
    const captures: RequestCapture[] = [];
    const client = new FakeMcpClient();
    setMcpClientSpawnerForTests(async () => client);
    registerProvider(
      [
        [
          { kind: "tool_call_complete", id: "tool-call-1", name: toolName, input: { value: "ok" } },
          { kind: "message_stop", stop_reason: "tool_calls" },
        ],
        [
          {
            kind: "text_delta",
            text: "The inline MCP tool completed successfully and returned data scoped to this fork only.",
          },
          { kind: "message_stop", stop_reason: "stop" },
        ],
      ],
      captures,
    );

    expect(toolRegistry.get(toolName)).toBeUndefined();

    const result = await runWithPermissionResolver(
      async () => "allow",
      () =>
        runForkLoopExternal({
          ctx: makeCtx(),
          name: "Inline MCP Test",
          body: "Use the inline MCP tool.",
          allowSet: new Set([toolName]),
          prompt: "Call the inline MCP tool once.",
          agentId: "inline-mcp-test-agent",
          inlineMcpServers: [{ inline: config }],
        }),
    );

    expect(result.isError).toBe(false);
    expect(captures[0]!.tools).toContainEqual(
      expect.objectContaining({ name: toolName, input_schema: { type: "object" } }),
    );
    expect(captures[1]!.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({ tool_use_id: "tool-call-1", type: "tool_result" }),
          ]),
        }),
      ]),
    );
    expect(client.calls).toEqual([{ name: "echo", args: { value: "ok" } }]);
    expect(client.isClosed()).toBe(true);
    expect(toolRegistry.get(toolName)).toBeUndefined();
  });

  test("continues without inline MCP tools when spawn fails", async () => {
    const captures: RequestCapture[] = [];
    setMcpClientSpawnerForTests(async () => {
      throw new Error("spawn failed");
    });
    registerProvider(
      [
        [
          {
            kind: "text_delta",
            text: "The fork continued after the inline MCP server failed to start and finished normally.",
          },
          { kind: "message_stop", stop_reason: "stop" },
        ],
      ],
      captures,
    );

    const result = await runWithPermissionResolver(
      async () => "allow",
      () =>
        runForkLoopExternal({
          ctx: makeCtx(),
          name: "Inline MCP Failure Test",
          body: "Finish without the inline MCP tool if it is unavailable.",
          allowSet: new Set([toolName]),
          prompt: "Finish normally.",
          agentId: "inline-mcp-failure-test-agent",
          inlineMcpServers: [{ inline: config }],
        }),
    );

    expect(result.isError).toBe(false);
    expect(captures[0]!.tools).not.toContainEqual(expect.objectContaining({ name: toolName }));
    expect(toolRegistry.get(toolName)).toBeUndefined();
  });
});
