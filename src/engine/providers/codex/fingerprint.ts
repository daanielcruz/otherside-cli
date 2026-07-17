import os from "node:os";
import { providerEndpoint } from "@/devtools/config.ts";
import type { WireFingerprint } from "@/engine/contract/types.ts";
import type { CodexRequestMetadata } from "@/engine/providers/codex/metadata.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

/** Responses/app-server client version observed on live ChatGPT Desktop wire. */
export const CODEX_CLI_VERSION = "0.144.5";
/** Electron shell product version (ChatGPT.app CFBundleShortVersionString). */
export const CODEX_APP_VERSION = "26.707.91948";

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const ISSUER = "https://auth.openai.com";
export const OAUTH_AUTHORIZE_URL = providerEndpoint(
  "codex",
  "authorize",
  `${ISSUER}/oauth/authorize`,
);
export const OAUTH_TOKEN_URL = providerEndpoint("codex", "token", `${ISSUER}/oauth/token`);
export const CALLBACK_PATH = "/auth/callback";
export const DEFAULT_PORT = 1455;
/**
 * The only loopback redirect URIs registered for this OAuth client.
 * The app-server binds 1455 and falls back to 1457; both are IdP-registered.
 * Any other port yields authorize_hydra_invalid_request, so we try only these.
 */
export const CALLBACK_PORTS = [1455, 1457];

export const SCOPE =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";

export const CHATGPT_BASE_URL = providerEndpoint(
  "codex",
  "base",
  "https://chatgpt.com/backend-api/codex",
);
export const RESPONSES_PATH = "/responses";
export const RESPONSES_URL = providerEndpoint(
  "codex",
  "responses",
  `${CHATGPT_BASE_URL}${RESPONSES_PATH}`,
);
export const RESPONSES_WS_URL = providerEndpoint(
  "codex",
  "responsesWs",
  `wss://chatgpt.com/backend-api/codex${RESPONSES_PATH}`,
);

/**
 * Live ChatGPT Desktop product originator.
 * Desktop does not split interactive / TUI / print originators — all surfaces use this value.
 */
export const ORIGINATOR_HTTP = "Codex Desktop";
export const ORIGINATOR_WS = ORIGINATOR_HTTP;
export const ORIGINATOR_EXEC = ORIGINATOR_HTTP;
export const CLIENT_METADATA_ORIGINATOR = ORIGINATOR_HTTP;

export const OPENAI_BETA_WS = "responses_websockets=2026-02-06";
export const BETA_FEATURES = "js_repl,memories";

export type SubAgentLabel = "review" | "compact" | "memory_consolidation" | "collab_spawn" | string;

/**
 * App-server User-Agent, matching the live wire:
 * `Codex Desktop/0.144.5 (Mac OS 27.0.0; arm64) iTerm.app/3.6.11 (Codex Desktop; 26.707.91948)`
 *
 * Shape: `{originator}/{cli_version} ({os} {os_version}; {arch}) [{term}/{ver} ]({originator}; {app_version})`.
 * The terminal segment is read from TERM_PROGRAM/TERM_PROGRAM_VERSION and omitted when absent.
 */
export function userAgent(): string {
  const base = `${ORIGINATOR_HTTP}/${CODEX_CLI_VERSION} (${uaOsPlatform()} ${osRelease()}; ${process.arch})`;
  const term = terminalSegment();
  const suffix = `(${ORIGINATOR_HTTP}; ${CODEX_APP_VERSION})`;
  return term ? `${base} ${term} ${suffix}` : `${base} ${suffix}`;
}

function uaOsPlatform(): string {
  switch (process.platform) {
    case "darwin":
      return "Mac OS";
    case "linux":
      return "X11; Linux";
    case "win32":
      return "Windows NT 10.0";
    default:
      return process.platform;
  }
}

function osRelease(): string {
  try {
    return os.release() || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function terminalSegment(): string | null {
  const program = process.env.TERM_PROGRAM?.trim();
  if (!program) return null;
  const version = process.env.TERM_PROGRAM_VERSION?.trim();
  return version ? `${program}/${version}` : program;
}

export interface CodexFingerprintOptions {
  bearer: string;
  accountId?: string | undefined;
  requestMetadata: CodexRequestMetadata;
  transport: "http" | "ws";
  wsKey?: string | undefined;
}

export function buildHeaders(opts: CodexFingerprintOptions): Record<string, string> {
  const originator = opts.transport === "ws" ? ORIGINATOR_WS : ORIGINATOR_HTTP;
  const headers: Record<string, string> = {
    Authorization: opts.bearer,
    originator,
    ...opts.requestMetadata.headerMetadata,
  };
  if (opts.transport === "http") headers["User-Agent"] = userAgent();
  // Live Desktop uses lowercase header name on backend-api surfaces.
  if (opts.accountId) headers["chatgpt-account-id"] = opts.accountId;

  if (opts.requestMetadata.subagentLabel === "memory_consolidation") {
    headers["x-openai-memgen-request"] = "true";
  }

  if (opts.transport === "ws") {
    headers.version = CODEX_CLI_VERSION;
    headers["x-codex-beta-features"] = BETA_FEATURES;
    headers["x-client-request-id"] = opts.requestMetadata.sessionId;
    headers["openai-beta"] = OPENAI_BETA_WS;
    headers.Upgrade = "websocket";
    headers.Connection = "Upgrade";
    headers["Sec-WebSocket-Version"] = "13";
    if (opts.wsKey) headers["Sec-WebSocket-Key"] = opts.wsKey;
  } else {
    headers["Content-Type"] = "application/json";
    headers.Accept = "text/event-stream";
  }
  return headers;
}

export function authHeaderValue(accessToken: string): string {
  return `Bearer ${accessToken}`;
}

export function fingerprint(_ctx: RequestContext): WireFingerprint {
  return {
    userAgent: userAgent(),
    extraHeaders: {
      originator: ORIGINATOR_HTTP,
    },
  };
}
