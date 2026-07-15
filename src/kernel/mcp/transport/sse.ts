import { parseWwwAuthenticate } from "@/kernel/mcp/oauth/discovery.ts";
import {
  CLIENT_NAME,
  CLIENT_VERSION,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
} from "@/kernel/mcp/protocol/constants.ts";
import { parseInstructions, parseServerCapabilities } from "@/kernel/mcp/protocol/parse.ts";
import {
  type JsonRpcResponse,
  type McpClient,
  type McpDirectoryListPage,
  type McpResourceInfo,
  McpRpcError,
  type McpServerCapabilities,
  type McpToolInfo,
  type SseServerConfig,
  UnauthorizedError,
} from "@/kernel/mcp/protocol/types.ts";
import {
  isTerminalMcpError,
  MAX_ERRORS_BEFORE_RECONNECT,
  recordMcpConnectionError,
  resetMcpConnectionErrors,
  scheduleReconnect,
} from "@/kernel/mcp/runtime/reconnect.ts";
import { parseBlock } from "@/kernel/std/stream/sse.ts";
import { buildHeaders } from "./headers.ts";
import {
  callToolVia,
  listDirectoryPageVia,
  listResourcesVia,
  listToolsVia,
  readResourceVia,
} from "./rpc-methods.ts";

const UNAUTHORIZED = 401;
const ACCEPTED = 202;

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const defaultSseFetch: FetchFn = (input, init) => fetch(input, init);
let sseFetchImpl: FetchFn = defaultSseFetch;

export function setSseTransportFetchForTests(impl: FetchFn | null): void {
  sseFetchImpl = impl ?? defaultSseFetch;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export class SseTransport implements McpClient {
  private serverName: string;
  private streamUrl: string;
  private config: SseServerConfig;
  private headers: Record<string, string>;
  private postUrl: string | null = null;
  private postUrlReady: Promise<void>;
  private resolvePostUrl: () => void = () => {};
  private rejectPostUrl: (err: Error) => void = () => {};
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private tools: McpToolInfo[] | null = null;
  private instructions: string | null = null;
  private capabilities: McpServerCapabilities | null = null;
  private closed = false;
  private streamAbort = new AbortController();

  private constructor(options: {
    serverName: string;
    config: SseServerConfig;
    headers: Record<string, string>;
  }) {
    this.serverName = options.serverName;
    this.config = options.config;
    this.streamUrl = options.config.url;
    this.headers = options.headers;
    this.postUrlReady = new Promise<void>((resolve, reject) => {
      this.resolvePostUrl = resolve;
      this.rejectPostUrl = reject;
    });
  }

  static async create(serverName: string, config: SseServerConfig): Promise<SseTransport> {
    const headers = await buildHeaders({ serverName, config });
    const client = new SseTransport({ serverName, config, headers });
    try {
      void client.openStream();
      await client.waitForPostUrl();
      await client.initialize();
      return client;
    } catch (err) {
      client.close();
      throw err;
    }
  }

  private async openStream(): Promise<void> {
    try {
      const res = await sseFetchImpl(this.streamUrl, {
        method: "GET",
        headers: { Accept: "text/event-stream", ...this.headers },
        signal: this.streamAbort.signal,
      });
      if (res.status === UNAUTHORIZED) {
        const challenge = res.headers.get("WWW-Authenticate") || "";
        const parsed = parseWwwAuthenticate(challenge);
        const err = new UnauthorizedError({
          message: `MCP sse \`${this.serverName}\` 401 unauthorized — run \`/mcp\` to authorize${challenge ? ` (${challenge})` : ""}`,
          challenge,
          resourceMetadataUrl: parsed?.resourceMetadataUrl ?? null,
        });
        this.rejectPostUrl(err);
        this.closeWithError(err);
        return;
      }
      if (!res.ok || !res.body) {
        const err = new Error(
          `MCP sse \`${this.serverName}\` stream HTTP ${res.status}${res.body ? "" : " (no body)"}`,
        );
        this.rejectPostUrl(err);
        this.closeWithError(err);
        return;
      }
      await this.consumeStream(res.body);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.rejectPostUrl(err);
      this.closeWithError(err);
    }
  }

  private async consumeStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    try {
      const decoder = new TextDecoder();
      let buffer = "";
      while (!this.closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf("\n\n");
        while (idx >= 0) {
          this.handleFrame(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
          idx = buffer.indexOf("\n\n");
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {}
      reader.releaseLock();
    }
  }

  private handleFrame(block: string): void {
    const frame = parseBlock(block);
    const event = frame.event ?? "message";
    const data = frame.data;
    if (event === "endpoint") {
      this.postUrl = resolveUrl(this.streamUrl, data);
      this.resolvePostUrl();
      return;
    }
    if (event !== "message") return;
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(data) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new McpRpcError(pending.method, msg.error));
      return;
    }
    pending.resolve(msg.result ?? null);
  }

  private async waitForPostUrl(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`MCP sse \`${this.serverName}\` endpoint frame timeout`)),
        REQUEST_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([this.postUrlReady, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async initialize(): Promise<void> {
    const init = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    });
    this.instructions = parseInstructions(init);
    this.capabilities = parseServerCapabilities(init);
    await this.notify("notifications/initialized", {});
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
    this.closeWithError(new Error("MCP sse client closed"));
  }

  private closeWithError(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.streamAbort.abort();
    } catch {}
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) throw new Error(`MCP sse \`${this.serverName}\` closed before \`${method}\``);
    if (!this.postUrl) throw new Error(`MCP sse \`${this.serverName}\` post URL not set`);
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`MCP sse \`${method}\` timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
        }
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, method });
    });
    let res: Response;
    try {
      res = await sseFetchImpl(this.postUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.headers },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
      }
      this.trackOutcome(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
    if (!res.ok && res.status !== ACCEPTED) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
      }
      const err = new Error(`MCP sse \`${this.serverName}\` ${method} POST → HTTP ${res.status}`);
      this.trackOutcome(err);
      throw err;
    }
    this.trackOutcome(null);
    return promise;
  }

  private trackOutcome(err: Error | null): void {
    if (err === null) {
      resetMcpConnectionErrors(this.serverName);
      return;
    }
    if (!isTerminalMcpError(err.message)) {
      resetMcpConnectionErrors(this.serverName);
      return;
    }
    const count = recordMcpConnectionError(this.serverName);
    if (count >= MAX_ERRORS_BEFORE_RECONNECT) {
      resetMcpConnectionErrors(this.serverName);
      void scheduleReconnect(this.serverName, this.config);
    }
  }

  private async notify(method: string, params: unknown): Promise<void> {
    if (this.closed || !this.postUrl) return;
    try {
      await sseFetchImpl(this.postUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.headers },
        body: JSON.stringify({ jsonrpc: "2.0", method, params }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {}
  }
}

function resolveUrl(base: string, ref: string): string {
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
}
