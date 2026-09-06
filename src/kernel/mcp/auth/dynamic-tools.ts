import { resolveAuthHeader } from "@/kernel/mcp/oauth/credentials.ts";
import { startOAuthFlow } from "@/kernel/mcp/oauth/flow.ts";
import type { McpServerConfig, RemoteServerConfig } from "@/kernel/mcp/protocol/types.ts";
import { parseWireToolName, wireToolName } from "@/kernel/mcp/protocol/wire-name.ts";
import { hasManualAuthHeader } from "@/kernel/mcp/transport/headers.ts";
import type { ToolHandler } from "@/kernel/std/tool-contract.ts";

const AUTHENTICATE_TOOL_KIND = "authenticate";
const COMPLETE_AUTHENTICATION_TOOL_KIND = "complete_authentication";

// The authenticate/complete_authentication pseudo-tools return an
// unconditional `{ behavior: "allow" }` — they never trigger the generic
// tool-use prompt, only
// whatever explicit deny/ask rule the user has configured for the wire name.
// Matched purely by wire-name shape (not by looking up the registered
// handler) so permission resolution stays a pure name check independent of
// this module and never touches the OAuth flow itself.
export function isMcpAuthToolName(name: string): boolean {
  const parsed = parseWireToolName(name);
  if (!parsed) return false;
  const [, tool] = parsed;
  return tool === AUTHENTICATE_TOOL_KIND || tool === COMPLETE_AUTHENTICATION_TOOL_KIND;
}

function buildAuthDescription(serverName: string, location: string): string {
  return (
    `The \`${serverName}\` MCP server (${location}) is installed but requires authentication. ` +
    `Call this tool to start the OAuth flow — you'll receive an authorization URL to share with the user. ` +
    `Once the user completes authorization in their browser, the server's real tools will become available automatically.`
  );
}

function buildCompleteAuthDescription(serverName: string): string {
  const authToolName = wireToolName(serverName, "authenticate");
  return (
    `Complete an in-progress OAuth flow for the \`${serverName}\` MCP server by submitting the callback URL. Call \`${authToolName}\` first to start the flow and get the authorization URL. ` +
    "After the user authorizes in their browser, the browser is redirected to a `http://localhost:<port>/callback?code=...&state=...` URL — " +
    "on remote sessions that page fails to load, but the URL in the address bar is still valid. Pass that full URL here as `callback_url`."
  );
}

interface InFlightFlow {
  submitCode: (code: string) => void;
  done: Promise<{ kind: string; reason?: string }>;
}

type AuthenticatedServerRefresher = (options: {
  serverName: string;
  config: McpServerConfig;
  cwd: string;
}) => Promise<void>;

const inFlightFlows = new Map<string, InFlightFlow>();

export function createMcpAuthToolPair(
  serverName: string,
  config: McpServerConfig,
  refreshAuthenticatedServer: AuthenticatedServerRefresher = async () => {},
): [ToolHandler, ToolHandler] {
  const url = "url" in config ? config.url : undefined;
  const transport = config.type ?? "stdio";
  const location = url ? `${transport} at ${url}` : transport;

  const authToolName = wireToolName(serverName, "authenticate");
  const completeToolName = wireToolName(serverName, "complete_authentication");

  const authTool: ToolHandler = {
    schema: {
      name: authToolName,
      description: buildAuthDescription(serverName, location),
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    isConcurrencySafe: false,
    async run(call, _ctx) {
      if (config.type !== "http" && config.type !== "sse") {
        return {
          tool_use_id: call.id,
          content: JSON.stringify({
            status: "unsupported",
            message: `Server "${serverName}" uses ${transport} transport which does not support OAuth from this tool. Ask the user to run /mcp and authenticate manually.`,
          }),
        };
      }
      if (!url) {
        return {
          tool_use_id: call.id,
          content: `MCP server "${serverName}" has no url field.`,
          is_error: true,
        };
      }
      try {
        const result = await startOAuthFlow({ serverName, baseUrl: url });
        // Outcomes reach the model through the complete_authentication result
        // that awaits this promise; nothing else reports them.
        const done = result.done.then(async (outcome) => {
          if (outcome.kind !== "saved") return outcome;
          try {
            await refreshAuthenticatedServer({ serverName, config, cwd: _ctx.cwd });
            return outcome;
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return { kind: "refresh-failed", reason: `tools could not refresh: ${reason}` };
          }
        });
        const flow = { submitCode: result.submitCode, done };
        inFlightFlows.set(serverName, flow);
        void done.finally(() => {
          if (inFlightFlows.get(serverName) === flow) inFlightFlows.delete(serverName);
        });
        return {
          tool_use_id: call.id,
          content: JSON.stringify({
            status: "auth_url",
            authUrl: result.authUrl,
            message: `Ask the user to open this URL in their browser to authorize the ${serverName} MCP server:\n\n${result.authUrl}\n\nOnce they complete the flow, the server's tools will become available automatically.\n\nIf the browser shows a connection error on the redirect page, ask the user to paste the full URL from the address bar and call \`${completeToolName}\` with it.`,
          }),
        };
      } catch (e) {
        return {
          tool_use_id: call.id,
          content: `Failed to start OAuth flow for ${serverName}: ${(e as Error).message}. Ask the user to run /mcp and authenticate manually.`,
          is_error: true,
        };
      }
    },
  };

  const completeAuthTool: ToolHandler = {
    schema: {
      name: completeToolName,
      description: buildCompleteAuthDescription(serverName),
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          callback_url: {
            type: "string",
            description:
              "The full callback URL from the browser address bar after authorizing, e.g. http://localhost:<port>/callback?code=...&state=...",
          },
        },
        required: ["callback_url"],
        additionalProperties: false,
      },
    },
    isConcurrencySafe: false,
    async run(call, _ctx) {
      const input = (call.input ?? {}) as { callback_url?: unknown };
      const callbackUrl = typeof input.callback_url === "string" ? input.callback_url : null;
      if (!callbackUrl) {
        return {
          tool_use_id: call.id,
          content: "callback_url is required",
          is_error: true,
        };
      }
      const flow = inFlightFlows.get(serverName);
      if (!flow) {
        return {
          tool_use_id: call.id,
          content: JSON.stringify({
            status: "error",
            message: `No OAuth flow is in progress for ${serverName}. Call \`${authToolName}\` first, then retry with the callback URL.`,
          }),
        };
      }
      let hasCode = false;
      try {
        const parsed = new URL(callbackUrl);
        hasCode = parsed.searchParams.has("code") || parsed.searchParams.has("error");
      } catch {}
      if (!hasCode) {
        return {
          tool_use_id: call.id,
          content: JSON.stringify({
            status: "error",
            message:
              "Invalid callback URL: missing authorization code. Ask the user to paste the full redirect URL from their browser's address bar, including the `?code=...&state=...` query string.",
          }),
        };
      }
      try {
        flow.submitCode(callbackUrl);
        const outcome = await flow.done;
        if (outcome.kind === "saved") {
          return {
            tool_use_id: call.id,
            content: JSON.stringify({
              status: "success",
              message: `Authentication complete for ${serverName}. The server's tools should now be available.`,
            }),
          };
        }
        return {
          tool_use_id: call.id,
          content: JSON.stringify({
            status: "error",
            message:
              outcome.kind === "refresh-failed"
                ? `Authentication completed for ${serverName}, but its tools could not be refreshed: ${outcome.reason ?? "unknown"}`
                : `Authentication failed for ${serverName}: ${outcome.reason ?? "unknown"}`,
          }),
        };
      } catch (e) {
        return {
          tool_use_id: call.id,
          content: JSON.stringify({
            status: "error",
            message: `Authentication failed for ${serverName}: ${(e as Error).message}`,
          }),
        };
      }
    },
  };

  return [authTool, completeAuthTool];
}

export function buildDynamicMcpAuthTools(
  servers: Record<string, McpServerConfig>,
  refreshAuthenticatedServer?: AuthenticatedServerRefresher,
): ToolHandler[] {
  const tools: ToolHandler[] = [];
  for (const [serverName, config] of Object.entries(servers)) {
    if (config.type !== "http" && config.type !== "sse") continue;
    const pair = createMcpAuthToolPair(serverName, config, refreshAuthenticatedServer);
    tools.push(...pair);
  }
  return tools;
}

function isOAuthCapable(config: McpServerConfig): config is RemoteServerConfig {
  if (config.type !== "http" && config.type !== "sse") return false;
  return !hasManualAuthHeader(config);
}

export async function selectOAuthCapableServers(
  servers: Record<string, McpServerConfig>,
): Promise<Record<string, RemoteServerConfig>> {
  const out: Record<string, RemoteServerConfig> = {};
  for (const [serverName, config] of Object.entries(servers)) {
    if (!isOAuthCapable(config)) continue;
    const credential = await resolveAuthHeader({ serverName, serverUrl: config.url });
    if (credential.kind === "header") continue;
    out[serverName] = config;
  }
  return out;
}
