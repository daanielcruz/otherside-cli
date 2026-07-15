import { providerEndpoint } from "@/devtools/config.ts";
import type { WireFingerprint } from "@/engine/contract/types.ts";
import type { CodexRequestMetadata } from "@/engine/providers/codex/metadata.ts";
import { getRuntimeKind } from "@/kernel/std/proc/runtime-mode.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";

export const CODEX_CLI_VERSION = "0.144.0";

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

export const ORIGINATOR_HTTP = "codex_cli_rs";
export const ORIGINATOR_WS = "codex-tui";
export const ORIGINATOR_EXEC = "codex_exec";
export const CLIENT_METADATA_ORIGINATOR = ORIGINATOR_HTTP;

function httpOriginator(): string {
  return getRuntimeKind() === "print" ? ORIGINATOR_EXEC : ORIGINATOR_HTTP;
}

export const OPENAI_BETA_WS = "responses_websockets=2026-02-06";
export const BETA_FEATURES = "js_repl,memories";

export type SubAgentLabel = "review" | "compact" | "memory_consolidation" | "collab_spawn" | string;

export function userAgent(): string {
  return `codex_cli_rs/${CODEX_CLI_VERSION} (${osShort()} unknown; ${archShort()})`;
}

function osShort(): string {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return process.platform;
  }
}

function archShort(): string {
  switch (process.arch) {
    case "arm64":
      return "aarch64";
    case "x64":
      return "x86_64";
    default:
      return process.arch;
  }
}

export interface CodexFingerprintOptions {
  bearer: string;
  accountId?: string | undefined;
  requestMetadata: CodexRequestMetadata;
  transport: "http" | "ws";
  wsKey?: string | undefined;
}

export function buildHeaders(opts: CodexFingerprintOptions): Record<string, string> {
  const originator = opts.transport === "ws" ? ORIGINATOR_WS : httpOriginator();
  const headers: Record<string, string> = {
    Authorization: opts.bearer,
    originator,
    ...opts.requestMetadata.headerMetadata,
  };
  if (opts.transport === "http") headers["User-Agent"] = userAgent();
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
      originator: httpOriginator(),
    },
  };
}
