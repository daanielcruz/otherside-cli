import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlashCommand } from "@/commands/catalog.ts";
import { handleServerPrompt } from "@/commands/handlers/mcp-prompt.ts";
import type { SlashContext } from "@/commands/types.ts";
import { forgetServerPrompts, refreshServerPrompts } from "@/engine/mcp/prompts.ts";
import {
  clientFor,
  closeAllClients,
  setMcpClientSpawnerForTests,
} from "@/kernel/mcp/client/registry.ts";
import type {
  McpClient,
  McpDirectoryListPage,
  McpPromptInfo,
  McpResourceInfo,
  McpServerCapabilities,
  McpToolInfo,
} from "@/kernel/mcp/protocol/types.ts";

/**
 * A server offering one prompt. `getPrompt` either answers with what it was
 * given or throws, so the handler's two outcomes — a turn, or a word to the
 * reader — are both reachable without a real transport.
 */
class PromptServer implements McpClient {
  private closed = false;
  constructor(
    private readonly options: {
      prompts?: McpPromptInfo[];
      result?: unknown;
      failure?: Error;
    },
  ) {}

  lastArgs: Record<string, string> | null = null;

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
    return { contents: [] };
  }
  async listDirectory(): Promise<McpDirectoryListPage> {
    return { resources: [] };
  }
  async listPrompts(): Promise<McpPromptInfo[]> {
    return this.options.prompts ?? [];
  }
  async getPrompt(_name: string, args: Record<string, string>): Promise<unknown> {
    this.lastArgs = args;
    if (this.options.failure) throw this.options.failure;
    return this.options.result ?? { messages: [] };
  }
  serverCapabilities(): McpServerCapabilities | null {
    return { prompts: {} };
  }
  serverInstructions(): string | null {
    return null;
  }
  announce(): void {}
  isClosed(): boolean {
    return this.closed;
  }
  close(): void {
    this.closed = true;
  }
}

const COMMAND: SlashCommand = { name: "notes:summarize", kind: "instant", description: "" };
const CTX = {} as SlashContext;

let configDir: string;
let previousConfigDir: string | undefined;

async function connect(server: PromptServer): Promise<void> {
  setMcpClientSpawnerForTests(async () => server);
  await clientFor("notes", { type: "stdio", command: "unused", args: [] });
  await refreshServerPrompts();
}

beforeEach(() => {
  previousConfigDir = process.env.OTHERSIDE_CONFIG_DIR;
  configDir = mkdtempSync(join(tmpdir(), "otherside-mcp-prompt-"));
  process.env.OTHERSIDE_CONFIG_DIR = configDir;
});

afterEach(async () => {
  await closeAllClients();
  setMcpClientSpawnerForTests(null);
  forgetServerPrompts();
  rmSync(configDir, { recursive: true, force: true });
  if (previousConfigDir === undefined) delete process.env.OTHERSIDE_CONFIG_DIR;
  else process.env.OTHERSIDE_CONFIG_DIR = previousConfigDir;
});

describe("running a prompt a server offers", () => {
  test("submits what the server returned instead of holding it back", async () => {
    await connect(
      new PromptServer({
        prompts: [{ name: "summarize", argumentNames: [] }],
        result: {
          messages: [{ role: "user", content: { type: "text", text: "Summarize this." } }],
        },
      }),
    );

    const result = await handleServerPrompt(COMMAND, "", CTX);

    expect(result.shouldQuery).toBe(true);
    expect(result.queryText).toBe("Summarize this.");
  });

  test("says nothing of its own, so the turn is the answer to the command", async () => {
    await connect(
      new PromptServer({
        prompts: [{ name: "summarize", argumentNames: [] }],
        result: { messages: [{ role: "user", content: { type: "text", text: "Go." } }] },
      }),
    );

    const result = await handleServerPrompt(COMMAND, "", CTX);

    expect(result.feedback).toBeUndefined();
  });

  test("gives the server the arguments the reader wrote", async () => {
    const server = new PromptServer({
      prompts: [{ name: "summarize", argumentNames: ["topic", "note"] }],
      result: { messages: [{ role: "user", content: { type: "text", text: "Done." } }] },
    });
    await connect(server);

    await handleServerPrompt(COMMAND, "birds keep it short", CTX);

    // The last declared argument still takes the rest of the line.
    expect(server.lastArgs).toEqual({ topic: "birds", note: "keep it short" });
  });
});

describe("when the prompt cannot be run", () => {
  test("a server that refused starts no turn and names the failure", async () => {
    await connect(
      new PromptServer({
        prompts: [{ name: "summarize", argumentNames: [] }],
        failure: new Error("server exploded"),
      }),
    );

    const result = await handleServerPrompt(COMMAND, "", CTX);

    expect(result.shouldQuery).toBeUndefined();
    expect(result.queryText).toBeUndefined();
    expect(result.feedback).toContain("server exploded");
  });

  test("an empty answer starts no turn, since a turn on nothing says nothing", async () => {
    await connect(
      new PromptServer({
        prompts: [{ name: "summarize", argumentNames: [] }],
        result: { messages: [] },
      }),
    );

    const result = await handleServerPrompt(COMMAND, "", CTX);

    expect(result.shouldQuery).toBeUndefined();
    expect(result.feedback).toContain("returned nothing");
  });

  test("a prompt its server no longer offers is unknown rather than sent", async () => {
    const result = await handleServerPrompt(COMMAND, "", CTX);

    expect(result.kind).toBe("unknown");
    expect(result.shouldQuery).toBeUndefined();
  });
});
