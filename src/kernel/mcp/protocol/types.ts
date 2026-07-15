export interface StdioServerConfig {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface HttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  oauthScopes?: string;
}

export interface SseServerConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  oauthScopes?: string;
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig | SseServerConfig;

export type McpServerSpec = string | { [name: string]: McpServerConfig };

export type RemoteServerConfig = HttpServerConfig | SseServerConfig;

/**
 * Enterprise allow/deny-list entry for `policySettings` (managed-settings.json)
 * MCP server policy. Exactly one of the three matchers is present:
 * - `serverName`: matches the server's key in the merged mcpServers map.
 * - `serverCommand`: matches a stdio server's full `[command, ...args]` array
 *   element-for-element.
 * - `serverUrl`: matches a remote (http/sse) server's URL, with `*` wildcards.
 * Mirrors upstream's AllowedMcpServerEntrySchema/DeniedMcpServerEntrySchema.
 */
export type McpServerPolicyEntry =
  | { serverName: string }
  | { serverCommand: string[] }
  | { serverUrl: string };

export type McpTransport = McpServerConfig["type"];

export interface McpJsonConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpResourceInfo {
  uri?: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** Direct child of a directory resource (`resources/directory/read`). */
export interface McpDirectoryEntry {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpDirectoryListPage {
  resources: McpDirectoryEntry[];
  nextCursor?: string;
}

/**
 * Server capabilities advertised in the `initialize` result.
 * `resources` present (object or true) means the server supports resource tools.
 * Directory listing is gated separately via the skills extension's `directoryRead`.
 */
export interface McpServerCapabilities {
  resources?: boolean | { subscribe?: boolean; listChanged?: boolean; [key: string]: unknown };
  tools?: boolean | { listChanged?: boolean; [key: string]: unknown };
  prompts?: boolean | { listChanged?: boolean; [key: string]: unknown };
  extensions?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
  [key: string]: unknown;
}

/** MCP skills extension URI used for directoryRead. */
export const MCP_SKILLS_EXTENSION_URI = "io.modelcontextprotocol/skills";

/** JSON-RPC Invalid params. */
export const MCP_INVALID_PARAMS = -32602;

/** Cap pages walked for `resources/directory/read` pagination. */
export const MAX_DIRECTORY_PAGES = 20;

/** Tool output character bound for MCP resource tools. */
export const MAX_MCP_RESOURCE_OUTPUT_CHARS = 100_000;

export type McpServerStatus = "disabled" | "connected" | "failed" | "needs-auth" | "untrusted";

export interface McpServerInspection {
  status: McpServerStatus;
  statusText: string;
  tools: McpToolInfo[];
  error: string | null;
}

export interface McpClient {
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
  listResources(): Promise<McpResourceInfo[]>;
  readResource(uri: string): Promise<unknown>;
  /** One page of `resources/directory/read`. Pagination is the caller's concern. */
  listDirectory(uri: string, options?: { cursor?: string }): Promise<McpDirectoryListPage>;
  serverCapabilities(): McpServerCapabilities | null;
  serverInstructions(): string | null;
  isClosed(): boolean;
  close(): void;
}

/** JSON-RPC error raised by MCP transports, preserving the numeric code. */
export class McpRpcError extends Error {
  readonly code: number;
  readonly method: string;

  constructor(method: string, error: { code?: number; message?: string; [key: string]: unknown }) {
    super(`MCP \`${method}\` error: ${JSON.stringify(error)}`);
    this.name = "McpRpcError";
    this.method = method;
    this.code = typeof error.code === "number" ? error.code : 0;
  }
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: unknown;
}

export interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export class UnauthorizedError extends Error {
  readonly challenge: string;
  readonly resourceMetadataUrl: string | null;

  constructor(options: { message: string; challenge: string; resourceMetadataUrl: string | null }) {
    super(options.message);
    this.name = "UnauthorizedError";
    this.challenge = options.challenge;
    this.resourceMetadataUrl = options.resourceMetadataUrl;
  }
}
