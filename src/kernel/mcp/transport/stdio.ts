import { recordPayloadDiagnostic } from "@/devtools/payload.ts";
import {
  CLIENT_NAME,
  CLIENT_VERSION,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
} from "@/kernel/mcp/protocol/constants.ts";
import { parseInstructions, parseServerCapabilities } from "@/kernel/mcp/protocol/parse.ts";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpClient,
  McpDirectoryListPage,
  McpResourceInfo,
  McpServerCapabilities,
  McpToolInfo,
  StdioServerConfig,
} from "@/kernel/mcp/protocol/types.ts";
import { McpRpcError } from "@/kernel/mcp/protocol/types.ts";
import { bashCommand } from "@/kernel/std/proc/shell.ts";
import {
  callToolVia,
  listDirectoryPageVia,
  listResourcesVia,
  listToolsVia,
  readResourceVia,
} from "./rpc-methods.ts";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

interface WritableSink {
  write(bytes: Uint8Array): unknown;
  flush?: () => unknown;
  end?: () => unknown;
  close?: () => unknown;
}

export class StdioTransport implements McpClient {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";
  private closed = false;
  private tools: McpToolInfo[] | null = null;
  private instructions: string | null = null;
  private capabilities: McpServerCapabilities | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | WritableSink | null = null;

  static async spawn(config: StdioServerConfig): Promise<StdioTransport> {
    const client = new StdioTransport();
    await client.start(config);
    return client;
  }

  private async start(config: StdioServerConfig): Promise<void> {
    const proc = Bun.spawn(bashCommand(buildShellCommand(config)), {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: buildEnv(config),
      ...(config.cwd ? { cwd: config.cwd } : {}),
    });
    this.proc = proc;
    this.writer = openWriter(proc.stdin);
    this.readLoop().catch(() => this.close());
    proc.exited.then(() => this.close()).catch(() => this.close());

    try {
      const initialized = await this.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      });
      this.instructions = parseInstructions(initialized);
      this.capabilities = parseServerCapabilities(initialized);
      this.notify("notifications/initialized", {});
    } catch (err) {
      this.close();
      throw err;
    }
  }

  private async readLoop(): Promise<void> {
    if (!this.proc) return;
    const reader = this.proc.stdout as ReadableStream<Uint8Array>;
    const decoder = new TextDecoder();
    for await (const chunk of reader) {
      this.buffer += decoder.decode(chunk, { stream: true });
      let idx = this.buffer.indexOf("\n");
      while (idx >= 0) {
        recordPayloadDiagnostic(
          "mcp-stdio-buffer",
          undefined,
          { toolName: "json-rpc", toolUseId: "pending-response" },
          { payloadChars: this.buffer.length },
        );
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        recordPayloadDiagnostic(
          "mcp-stdio-line",
          undefined,
          { toolName: "json-rpc", toolUseId: "pending-response" },
          { payloadChars: line.length },
        );
        if (line.length > 0) this.handleLine(line);
        idx = this.buffer.indexOf("\n");
      }
    }
  }

  private handleLine(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    recordPayloadDiagnostic(
      "mcp-stdio-parsed",
      undefined,
      { toolName: pending.method, toolUseId: `rpc-${msg.id}` },
      { payloadChars: line.length },
    );
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new McpRpcError(pending.method, msg.error));
      return;
    }
    pending.resolve(msg.result ?? null);
  }

  private write(value: JsonRpcRequest | JsonRpcNotification): void {
    if (!this.writer || this.closed) throw new Error("MCP stdio: client closed");
    const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    const result = this.writer.write(bytes);
    if (isPromiseLike(result)) result.catch(() => this.close());
    if (isWritableSink(this.writer) && this.writer.flush) {
      const flushed = this.writer.flush();
      if (isPromiseLike(flushed)) flushed.catch(() => this.close());
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`MCP server closed before \`${method}\``));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(
            new Error(`MCP request \`${method}\` timed out after ${REQUEST_TIMEOUT_MS / 1000}s`),
          );
        }
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    try {
      this.write({ jsonrpc: "2.0", method, params });
    } catch {}
  }

  async listTools(): Promise<McpToolInfo[]> {
    if (this.tools) return this.tools;
    this.tools = await listToolsVia((method, params) => this.request(method, params));
    return this.tools;
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    return callToolVia((method, params) => this.request(method, params), { name, args });
  }

  async listResources(): Promise<McpResourceInfo[]> {
    return listResourcesVia((method, params) => this.request(method, params));
  }

  async readResource(uri: string): Promise<unknown> {
    return readResourceVia((method, params) => this.request(method, params), uri);
  }

  async listDirectory(uri: string, options?: { cursor?: string }): Promise<McpDirectoryListPage> {
    return listDirectoryPageVia(
      (method, params) => this.request(method, params),
      uri,
      options?.cursor,
    );
  }

  serverCapabilities(): McpServerCapabilities | null {
    return this.capabilities;
  }

  serverInstructions(): string | null {
    return this.instructions;
  }

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP server closed while waiting for \`${pending.method}\``));
    }
    this.pending.clear();
    closeWriter(this.writer);
    this.writer = null;
    try {
      this.proc?.kill();
    } catch {}
    this.proc = null;
  }
}

function buildShellCommand(config: StdioServerConfig): string {
  return [config.command, ...config.args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildEnv(config: StdioServerConfig): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") merged[key] = value;
  }
  if (config.env) {
    for (const [key, value] of Object.entries(config.env)) merged[key] = value;
  }
  return merged;
}

function openWriter(stdin: unknown): WritableStreamDefaultWriter<Uint8Array> | WritableSink {
  if (stdin instanceof WritableStream) return stdin.getWriter();
  if (isWritableSink(stdin)) return stdin;
  throw new Error("MCP stdio: stdin handle is not writable");
}

function closeWriter(writer: WritableStreamDefaultWriter<Uint8Array> | WritableSink | null): void {
  if (!writer) return;
  try {
    const closed = "close" in writer ? writer.close?.() : undefined;
    if (isPromiseLike(closed)) closed.catch(() => {});
  } catch {}
  try {
    const ended = "end" in writer ? (writer as WritableSink).end?.() : undefined;
    if (isPromiseLike(ended)) ended.catch(() => {});
  } catch {}
}

function isWritableSink(value: unknown): value is WritableSink {
  return Boolean(value) && typeof (value as WritableSink).write === "function";
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return Boolean(value) && typeof (value as Promise<unknown>).catch === "function";
}
