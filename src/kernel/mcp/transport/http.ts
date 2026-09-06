import { refreshWithLock, tokenBoundToServer } from "@/kernel/mcp/oauth/credentials.ts";
import { parseWwwAuthenticate } from "@/kernel/mcp/oauth/discovery.ts";
import {
  CLIENT_NAME,
  CLIENT_VERSION,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
} from "@/kernel/mcp/protocol/constants.ts";
import { parseInstructions, parseServerCapabilities } from "@/kernel/mcp/protocol/parse.ts";
import { mcpRequestSignal } from "@/kernel/mcp/protocol/request-signal.ts";
import {
  type HttpServerConfig,
  type JsonRpcResponse,
  type McpCallToolOptions,
  type McpClient,
  type McpDirectoryListPage,
  type McpPromptInfo,
  type McpResourceInfo,
  McpRpcError,
  type McpServerCapabilities,
  type McpToolInfo,
  UnauthorizedError,
} from "@/kernel/mcp/protocol/types.ts";
import {
  isTerminalMcpError,
  MAX_ERRORS_BEFORE_RECONNECT,
  recordMcpConnectionError,
  resetMcpConnectionErrors,
  scheduleReconnect,
} from "@/kernel/mcp/runtime/reconnect.ts";
import { clientCapabilities } from "@/kernel/mcp/transport/capabilities.ts";
import { AbortError } from "@/kernel/std/stream/abort.ts";
import { buildHeaders, hasManualAuthHeader } from "./headers.ts";
import {
  callToolVia,
  getPromptVia,
  listDirectoryPageVia,
  listPromptsVia,
  listResourcesVia,
  listToolsVia,
  readResourceVia,
} from "./rpc-methods.ts";

const UNAUTHORIZED = 401;

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const defaultHttpFetch: FetchFn = (input, init) => fetch(input, init);
let httpFetchImpl: FetchFn = defaultHttpFetch;

export function setHttpTransportFetchForTests(impl: FetchFn | null): void {
  httpFetchImpl = impl ?? defaultHttpFetch;
}

export class HttpTransport implements McpClient {
  private url: string;
  private serverName: string;
  private config: HttpServerConfig;
  private headers: Record<string, string>;
  private sessionId: string | null = null;
  private nextId = 1;
  private tools: McpToolInfo[] | null = null;
  private instructions: string | null = null;
  private capabilities: McpServerCapabilities | null = null;
  private closed = false;

  private constructor(options: {
    serverName: string;
    config: HttpServerConfig;
    headers: Record<string, string>;
  }) {
    this.serverName = options.serverName;
    this.config = options.config;
    this.url = options.config.url;
    this.headers = options.headers;
  }

  static async create(serverName: string, config: HttpServerConfig): Promise<HttpTransport> {
    const headers = await buildHeaders({ serverName, config });
    const client = new HttpTransport({ serverName, config, headers });
    await client.initialize();
    return client;
  }

  private async initialize(): Promise<void> {
    const init = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: clientCapabilities(),
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

  async callTool(name: string, args: unknown, options?: McpCallToolOptions): Promise<unknown> {
    return callToolVia((method, params) => this.request(method, params, options?.signal), {
      name,
      args,
    });
  }

  async listPrompts(): Promise<McpPromptInfo[]> {
    return listPromptsVia((method, params) => this.request(method, params));
  }

  async getPrompt(name: string, args: Record<string, string>): Promise<unknown> {
    return getPromptVia((method, params) => this.request(method, params), { name, args });
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
    this.closed = true;
  }

  private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error(`MCP http \`${this.serverName}\` closed before \`${method}\``);
    if (signal?.aborted) throw new AbortError();
    const message = await this.send(method, params, true, signal);
    if (message.error) {
      throw new McpRpcError(method, message.error);
    }
    return message.result ?? null;
  }

  private async send(
    method: string,
    params: unknown,
    allowRetry: boolean,
    signal?: AbortSignal,
  ): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    let res: Response;
    try {
      res = await httpFetchImpl(this.url, {
        method: "POST",
        headers: this.requestHeaders(),
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: mcpRequestSignal(signal),
      });
    } catch (e) {
      this.trackOutcome(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
    const newSession = res.headers.get("Mcp-Session-Id");
    if (newSession) this.sessionId = newSession;
    if (res.status === UNAUTHORIZED) {
      return this.onUnauthorized(method, params, allowRetry, res, signal);
    }
    if (!res.ok) {
      const text = await safeReadText(res);
      const err = new Error(
        `MCP http \`${this.serverName}\` ${method} → HTTP ${res.status}${text ? `: ${clip(text)}` : ""}`,
      );
      this.trackOutcome(err);
      throw err;
    }
    const response = await readJsonRpcResponse(res, id);
    this.trackOutcome(null);
    return response;
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

  private async onUnauthorized(
    method: string,
    params: unknown,
    allowRetry: boolean,
    res: Response,
    signal?: AbortSignal,
  ): Promise<JsonRpcResponse> {
    const challenge = res.headers.get("WWW-Authenticate") || "";
    if (
      allowRetry &&
      !hasManualAuthHeader(this.config) &&
      tokenBoundToServer(this.serverName, this.url)
    ) {
      const refreshed = await refreshWithLock(this.serverName);
      if (refreshed.kind === "header") {
        this.headers = { ...this.headers, Authorization: refreshed.value };
        return this.send(method, params, false, signal);
      }
    }
    const parsed = parseWwwAuthenticate(challenge);
    throw new UnauthorizedError({
      message: `MCP http \`${this.serverName}\` 401 unauthorized — run \`/mcp\` to authorize${challenge ? ` (${challenge})` : ""}`,
      challenge,
      resourceMetadataUrl: parsed?.resourceMetadataUrl ?? null,
    });
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.headers,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    return headers;
  }

  announce(method: string, params: unknown): void {
    void this.notify(method, params).catch(() => {});
  }

  private async notify(method: string, params: unknown): Promise<void> {
    try {
      await httpFetchImpl(this.url, {
        method: "POST",
        headers: this.requestHeaders(),
        body: JSON.stringify({ jsonrpc: "2.0", method, params }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {}
  }
}

async function readJsonRpcResponse(res: Response, expectId: number): Promise<JsonRpcResponse> {
  const contentType = (res.headers.get("Content-Type") || "").toLowerCase();
  if (contentType.includes("text/event-stream")) return readSseUntil(res, expectId);
  return (await res.json()) as JsonRpcResponse;
}

async function readSseUntil(res: Response, expectId: number): Promise<JsonRpcResponse> {
  const body = res.body;
  if (!body) throw new Error("MCP http: empty SSE response");
  const reader = body.getReader();
  try {
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx >= 0) {
        const message = parseSseFrame(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
        if (message && typeof message.id === "number" && message.id === expectId) {
          try {
            await reader.cancel();
          } catch {}
          return message;
        }
        idx = buffer.indexOf("\n\n");
      }
    }
    throw new Error(`MCP http: SSE stream ended without response for id ${expectId}`);
  } finally {
    reader.releaseLock();
  }
}

function parseSseFrame(block: string): JsonRpcResponse | null {
  const dataLines: string[] = [];
  for (const raw of block.split(/\r?\n/)) {
    if (raw.startsWith("data:")) dataLines.push(raw.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join("\n")) as JsonRpcResponse;
  } catch {
    return null;
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function clip(text: string): string {
  const max = 200;
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
